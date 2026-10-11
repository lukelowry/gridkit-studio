/** What the Network brings to the canvas: its renderer, loaded while the worker prepares the case;
 *  the samples it maps at the time it shows, asked for as the clock moves; the map beneath a
 *  network on Earth; and its projections, rotation and labels. */

import type { Geography } from '@latkit/geography'
import type { Gpu, ProjectedCamera } from '@latkit/gpu'
import type { Data } from '@latkit/model'
import type { Network } from '@latkit/network'

import { reader } from '../../shared/preferences.js'
import { bridge } from '../bridge.js'
import { createClock } from '../clock.js'
import type { Host, Kind } from '../kind.js'
import { drawable, staticNeeds } from '../rows.js'
import { networkNeeds, Samples } from '../samples.js'
import { theme } from '../theme.js'
import { icon, type IconName } from '../ui/glyphs.js'
import type { Loaded } from './map.js'
import type { Projection } from './network.js'

const PROJECTIONS: readonly { value: Projection; label: string; icon: IconName }[] = [
  { value: 'flat', label: 'Flat', icon: 'projection-flat' },
  { value: 'tilt', label: 'Tilt', icon: 'projection-tilt' },
  { value: 'globe', label: 'Globe', icon: 'projection-globe' },
]

export function network(host: Host): Kind {
  const { element, canvas } = host
  const availability = element.querySelector<HTMLElement>('.canvas-host__status')!
  let module: typeof import('./network.js') | undefined
  let styles: typeof import('./style.js') | undefined
  const loaded = Promise.all([import('./network.js'), import('./style.js')]).then(
    ([network, style]) => {
      module = network
      styles = style
    },
  )
  /** The map's code, which only a case on Earth loads, once it is on screen. */
  let maps: typeof import('./map.js') | undefined
  let mapping: Promise<unknown> | undefined
  /** The rows with the samples held, which it draws; and those it last drew. */
  let data: Data | undefined
  let painted: Data | undefined
  /** The time it last readied for, which it then draws. */
  let at = 0
  let geographic = false
  /** The GPU the network draws on, and the map beneath a network on Earth: made once the case is on
   *  screen; what it draws, once loaded; which map that is, or is loading; and whether its ground
   *  was last made for a flat camera. */
  let device: Gpu | undefined
  let earth: Geography | undefined
  let map: Loaded | null = null
  let mapped: string | undefined
  let flatGround: boolean | undefined
  /** Labels and the map wait for the first frame, so neither text layout nor the map's pipelines
   *  ever delay it. */
  let onScreen = false
  /** Topology is unchanged by sampled frames. Do not rescan coordinates on every update. */
  let located: Data | undefined
  let preferredProjection: ProjectedCamera.Projection | undefined
  let buffering: ReturnType<typeof setTimeout> | undefined
  let sync = () => {}

  // Samples draw when the time shown needs them.
  const samples = new Samples(bridge, () => {
    host.received()
    show(clock.now())
  })
  const clock = createClock(show)
  const config = (rows: Data) =>
    styles!.networkConfig(
      rows,
      data ?? rows,
      host.state(),
      geographic ? (earth ?? null) : null,
      onScreen,
    )
  const ground = (view: Network) => {
    const { palette, font } = theme()
    flatGround = module!.isFlat(view.camera.projection)
    return maps!.mapConfig(reader(host.state().settings), palette, font, map, flatGround)
  }
  /** The ground's look follows the camera: one turned from flat to tilted or round, or back, paints
   *  it again. */
  const regrounded = () => {
    const view = host.view() as Network | undefined
    if (earth && view && module!.isFlat(view.camera.projection) !== flatGround) host.paint()
  }
  const chosen = (): Projection => host.state().settings?.['network.camera.projection'] ?? 'flat'
  const preferred = () => module!.projectionOf(chosen(), geographic)

  /** Whether it holds what it maps at `t`: rows of this revision, and the samples its mappings
   *  read over that time. */
  function covered(t: number): boolean {
    const state = host.state()
    if (!drawable(host.rows(), state)) return false
    const { results, summary } = state
    if (!results?.frames || results.fingerprint !== summary?.fingerprint) return true
    if (t < results.domain[0] || t > results.domain[1]) return false
    return networkNeeds(state).every(({ selection }) =>
      samples.covers(selection.from, selection.select[0]!, [t, t]),
    )
  }
  /** Whether it can draw `t`. It asks for the samples that time needs, then those nearest it, and
   *  draws from the samples it holds once they cover it. */
  function readyAt(t: number): boolean {
    at = t
    const state = host.state()
    const { results } = state
    const unavailable = results && (t < results.domain[0] || t > results.domain[1])
    const played = clock.state
    const travel = played.status === 'playing' ? played.rate * played.direction : 0
    samples.want(results, networkNeeds(state), unavailable ? undefined : [t, t], { at: t, travel })
    const rows = host.rows()
    if (rows) data = samples.data(rows.data)
    const available = covered(t)
    const status = unavailable ? 'unavailable' : available ? 'ready' : 'buffering'
    if (element.dataset.availability !== status) {
      element.setAttribute('aria-busy', String(status === 'buffering'))
      element.dataset.availability = status
      clearTimeout(buffering)
      availability.hidden = true
      if (status !== 'ready')
        buffering = setTimeout(() => {
          availability.textContent =
            status === 'buffering' ? 'Loading samples…' : 'No recorded sample at this time.'
          availability.hidden = !host.rendered()
        }, 150)
    }
    return available
  }
  /** Shows time `t`. Source and time change together. An uncovered seek keeps the last valid frame
   *  visible. */
  function show(t: number) {
    if (!host.shown() || !readyAt(t)) return
    const view = host.view() as Network | undefined
    if (view && painted === data) view.set({ at: t })
    else if (!view) host.render()
    // Pages reach the view as time does, this frame; a restyle waits for the next.
    else host.paintNow()
  }
  /** Loads the map after the first frame, so neither its code nor its data delays the case, and
   *  again once the settings choose another. A map that fails is reported, and tried again on a
   *  retry or another choice. */
  function decorate() {
    if (!geographic || host.closed()) return
    if (!maps) {
      // Painting once the code is in lays the ground, and loads the map chosen.
      mapping ??= import('./map.js').then(
        (map) => {
          maps = map
          if (!host.closed()) host.paint()
        },
        (reason: unknown) => {
          mapping = undefined
          bridge.report(reason)
        },
      )
      return
    }
    const s = reader(host.state().settings)
    const key = maps.mapKey(s)
    if (key === mapped) return
    mapped = key
    void maps.loadMap(s).then(
      (value) => {
        if (mapped !== key || host.closed()) return
        map = value
        host.paint()
      },
      (reason) => bridge.report(reason),
    )
  }
  /** Credits the map's tiles in the corner, as their license asks, while they draw. */
  function credit() {
    const text = geographic && map?.kind === 'openstreetmap' ? map.attribution : undefined
    let node = element.querySelector<HTMLElement>('.canvas-host__credit')
    if (!text) {
      node?.remove()
      return
    }
    if (!node) {
      node = document.createElement('div')
      node.className = 'canvas-host__credit'
      element.append(node)
    }
    node.textContent = text
  }
  const orbit = (view: Network | undefined) => {
    if (!view || host.state().settings?.['accessibility.motion'] === 'reduce') return
    view.set({ camera: { orbit: !view.camera.orbit } })
  }
  /** Adds its projections and rotation over its top right; returns what syncs their state. Fit is
   *  the editor's own title action. */
  function toolbar() {
    const bar = document.createElement('div')
    bar.className = 'toolbar'
    bar.setAttribute('role', 'group')
    bar.setAttribute('aria-label', 'View controls')
    bar.dataset.testid = 'view-toolbar'
    const button = (name: IconName, label: string, press: () => void) => {
      const control = document.createElement('button')
      control.type = 'button'
      control.className = 'c-icon-btn'
      control.title = label
      control.setAttribute('aria-label', label)
      control.innerHTML = icon(name)
      control.addEventListener('click', () => {
        press()
        sync()
      })
      bar.append(control)
      return control
    }
    const network = () => host.view() as Network
    const projections = PROJECTIONS.map(({ value, label, icon }) => ({
      value,
      control: button(icon, label, () => module!.setProjection(network(), value)),
    }))
    const orbiting = button('orbit', 'Auto-rotate', () => orbit(network()))
    element.append(bar)
    return () => {
      const view = host.view() as Network | undefined
      if (!view) return
      const { camera, projections: offered } = view
      for (const { value, control } of projections) {
        control.setAttribute('aria-pressed', String(module!.offeredAs(camera.projection) === value))
        control.disabled =
          !offered[module!.projectionOf(value, geographic)] || (value === 'globe' && !geographic)
      }
      orbiting.setAttribute('aria-pressed', String(camera.orbit === true))
    }
  }

  return {
    loaded,
    presentation: false,
    needs: (summary, bindings) => staticNeeds(summary, bindings, true),
    // It waits for the static fields its mappings read.
    current: (rows) => drawable(rows, host.state()),
    ready: () => readyAt(clock.now()),
    arrange(rows) {
      if (!readyAt(clock.now()) || !module || !styles) return false
      host.mark('canvas:module')
      if (located !== rows.data) {
        geographic = module.isGeographic(rows.data)
        located = rows.data
      }
      return true
    },
    mount(gpu, rows) {
      onScreen = false
      device = gpu
      preferredProjection = preferred()
      return module!.mountNetwork(
        gpu,
        canvas,
        {
          ...config(rows.data),
          at,
          camera: { projection: preferredProjection, orbit: false, fit: true },
        },
        () => host.state(),
        host.select,
        host.open,
      )
    },
    paint(view, rows) {
      const network = view as Network
      // Until the case is on screen the network draws alone, its own grid standing for the map's.
      if (earth) earth.set(ground(network), { replace: true })
      else if (onScreen && geographic && maps)
        earth = maps.mountEarth(device!, ground(network), (reason) => bridge.report(reason))
      network.set({ ...config(rows.data), at }, { replace: true })
      painted = data
      credit()
    },
    painted(view) {
      if (host.rendered()) decorate()
      // The projection setting applies only when it changes, so restyling never resets navigation.
      const projection = preferred()
      if (preferredProjection === projection) return
      preferredProjection = projection
      module!.setProjection(view as Network, chosen())
      sync()
    },
    presented() {
      if (!element.querySelector('.toolbar')) sync = toolbar()
      sync()
      // The case is on screen: add its labels, and the map beneath it.
      onScreen = true
      host.paint()
    },
    unmount() {
      earth?.destroy()
      earth = undefined
      device = undefined
    },
    item: (view, element) => module!.networkItem(view as Network, element),
    sync: () => {
      sync()
      regrounded()
    },
    act(view, command, value) {
      if (command === 'projection') module!.setProjection(view as Network, value as Projection)
      else if (command === 'orbit') orbit(view as Network)
    },
    retry() {
      mapped = undefined
      samples.retry()
    },
    stats: () => ({
      requestedAt: clock.now(),
      samples: samples.stats(),
      availability: element.dataset.availability,
      map: geographic ? earth?.stats() : undefined,
    }),
    dispose() {
      clearTimeout(buffering)
      clock.stop()
    },
  }
}
