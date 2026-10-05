/** The Network and Diagram editors, framework-free so nothing delays a case's first frame. */

import './styles/index.css'
import './styles/canvas.css'

import type { Diagram, Positions } from '@latkit/diagram'
import type { Data } from '@latkit/model'
import type { Network, Projection } from '@latkit/network'

import type { Begin, Element, ViewState } from '../shared/messages.js'
import { bridge, merged } from './bridge.js'
import { createClock } from './clock.js'
import { CanvasGpu, RECOVER_MS } from './gpu.js'
import { loadBorders } from './network/borders.js'
import { DIAGRAM, NETWORK, patchOf } from './patch.js'
import { receive } from './stream.js'
import { appearance, watchTheme } from './theme.js'
import { icon, type IconName } from './ui/glyphs.js'

/** How long the camera rests before its framing is saved. */
const SAVE_MS = 200

const PROJECTIONS: readonly { value: Projection; label: string; icon: IconName }[] = [
  { value: 'flat', label: 'Flat', icon: 'projection-flat' },
  { value: 'tilt', label: 'Tilt', icon: 'projection-tilt' },
  { value: 'globe', label: 'Globe', icon: 'projection-globe' },
]

function boot() {
  const mark = (name: string) => {
    if (!performance.getEntriesByName(name).length) performance.mark(name)
  }
  mark('canvas:boot')
  const kind = document.body.dataset.kind
  if (kind !== 'network' && kind !== 'diagram') return
  const hint =
    (kind === 'network' ? 'Network' : 'Diagram') + ' view. Right-click an element for actions.'
  document.getElementById('app')!.innerHTML =
    '<main class="canvas-host" aria-busy="true"><div class="canvas-host__notice" role="status" hidden></div><canvas class="canvas-host__canvas" tabindex="0"></canvas><div class="canvas-host__fallback c-empty" role="status"><p class="c-empty__text">Loading case…</p></div></main>'
  const host = document.querySelector<HTMLElement>('.canvas-host')!
  const canvas = host.querySelector('canvas')!
  const fallback = host.querySelector<HTMLElement>('.canvas-host__fallback')!
  const fallbackText = fallback.firstElementChild!
  const notice = host.querySelector<HTMLElement>('.canvas-host__notice')!
  canvas.setAttribute('aria-label', hint)
  canvas.addEventListener('contextmenu', (event) => event.stopPropagation())

  const owner = new CanvasGpu()
  let networkModule: typeof import('./network/network.js') | undefined
  let networkStyles: typeof import('./network/style.js') | undefined
  let diagramModule: typeof import('./diagram/diagram.js') | undefined
  let diagramStyles: typeof import('./diagram/style.js') | undefined
  /** The case's rows alone, and with the shown run's samples. */
  let rows: Data | undefined
  let data: Data | undefined
  let view: Network | Diagram | undefined
  /** The config the view last received; the next paint sends only the difference. */
  let drawn: Record<string, unknown> | undefined
  let state: ViewState = {}
  /** The times of the run the case holds; undefined when it holds all of them. */
  let held: Begin['held']
  /** Whether the view has asked for other times of the run and not yet received them. */
  let asked = false
  let places: Record<string, Positions> = {}
  let closed = false
  /** Whether VS Code shows the view; a hidden view keeps its webview but pauses. */
  let shown = true
  let rendering = false
  let queued = false
  let geographic = false
  let borders: Data | null = null
  let borderRequest: Promise<void> | undefined
  /** Labels, like borders, wait for the first frame so text layout never delays it. */
  let labelled = false
  /** The shown selection, and the last one this view made, which it does not reveal. */
  let selectionKey = ''
  let own = ''
  let preferredProjection: Projection | undefined
  /** The camera to restore after the GPU is lost, and when the GPU was last replaced. */
  let restore: unknown
  let recovered = -Infinity
  let saving: ReturnType<typeof setTimeout> | undefined
  let sync = () => {}

  const keyOf = (element?: Element | null) => (element?.id ?? '') + ':' + (element?.field ?? '')
  /** Say what the view shows when it is not the source being typed: the last valid revision, or,
   *  before any, nothing until the case's problems are fixed. Errors themselves are said once, by
   *  the extension. */
  const say = () => {
    const unread = !state.summary && !!state.error
    notice.hidden = !unread && !(state.stale && state.summary)
    notice.textContent = unread
      ? 'The case draws once the problems listed in Problems are fixed.'
      : 'Showing the last valid revision until the source is fixed. Editing waits for it.'
    if (unread) {
      fallback.hidden = true
      host.setAttribute('aria-busy', 'false')
    } else if (!canvas.dataset.rendered) {
      fallback.hidden = false
    }
  }
  /** The view cannot draw: it stops waiting, and the extension says why. */
  const error = (reason: unknown) => {
    if (!canvas.dataset.rendered) fallback.hidden = true
    host.setAttribute('aria-busy', 'false')
    bridge.report(reason)
  }
  const drop = () => {
    view?.destroy()
    view = undefined
    drawn = undefined
    labelled = false
    delete canvas.dataset.rendered
  }
  /** Replace a lost GPU and redraw where the camera was. */
  const lost = () => {
    restore = view?.camera
    drop()
    if (performance.now() - recovered < RECOVER_MS) return error('WebGPU device lost.')
    recovered = performance.now()
    void render().catch(error)
  }
  // Load the renderer while the worker prepares the case.
  const rendererReady =
    kind === 'network'
      ? Promise.all([import('./network/network.js'), import('./network/style.js')]).then(
          ([module, styles]) => {
            networkModule = module
            networkStyles = styles
          },
        )
      : Promise.all([import('./diagram/diagram.js'), import('./diagram/style.js')]).then(
          ([module, styles]) => {
            diagramModule = module
            diagramStyles = styles
          },
        )
  void rendererReady.catch(error)
  void owner.get(lost).catch(error)

  const select = (element: Element | null) => {
    own = keyOf(element)
    bridge.send({ kind: 'select', element })
  }
  const open = (element: Element) => {
    select(element)
    bridge.command('elementSource')
  }
  const networkConfig = () =>
    networkStyles!.networkConfig(
      rows!,
      data!,
      places,
      state,
      geographic,
      borders,
      // Colors span the whole run once all of it is held and no more is coming.
      held === undefined && state.run?.state !== 'running',
      labelled,
    )
  const diagramConfig = () => diagramStyles!.diagramConfig(rows!, state, places)
  const config = (): Record<string, unknown> =>
    kind === 'diagram' ? diagramConfig() : networkConfig()
  const orbit = () => {
    if (kind !== 'network' || !view || state.settings?.['accessibility.motion'] === 'reduce') return
    const network = view as Network
    network.set({ camera: { orbit: !network.camera.orbit } })
  }
  /** Load borders after the first frame, so decoration never delays the case. */
  function decorate() {
    if (
      kind !== 'network' ||
      !geographic ||
      state.settings?.['network.borders'] === false ||
      borders ||
      borderRequest ||
      closed
    )
      return
    borderRequest = loadBorders()
      .then((value) => {
        if (closed) return
        borders = value
        paint()
      })
      .catch((reason) => bridge.report(reason))
  }
  /** Send the view only what changed, so it keeps what it has read, scaled, laid out, and
   *  uploaded. */
  function paint() {
    if (!view || !drawn || !rows || !data || closed) return
    appearance(state.settings)
    try {
      const next = config()
      const patch = patchOf(drawn, next, kind === 'network' ? NETWORK : DIAGRAM)
      if (patch) view.set(patch as never)
      drawn = next
    } catch (reason) {
      return error(reason)
    }
    if (canvas.dataset.rendered) decorate()
    if (kind !== 'network') return
    // Apply the projection setting only when it changes, so restyling never resets navigation.
    const projection = networkModule!.projectionOf(
      state.settings?.['network.camera.projection'] ?? 'flat',
      geographic,
    )
    if (preferredProjection !== projection) {
      preferredProjection = projection
      networkModule!.setProjection(view as Network, projection)
      sync()
    }
  }
  function selection(force = false) {
    if (!view) return
    const key = keyOf(state.selection)
    const moved = key !== selectionKey
    if (!force && !moved) return
    selectionKey = key
    try {
      const item = state.selection
        ? kind === 'diagram'
          ? diagramModule!.diagramItem(view as Diagram, state.selection)
          : networkModule!.networkItem(view as Network, state.selection)
        : undefined
      view.select((item ? [item] : []) as never)
      // Reveal only a new selection, not the same one found again in new rows.
      if (item && moved && state.navigate && key !== own) view.reveal(item as never)
    } catch {
      /* A newer document projection can supersede the selection. */
    }
  }
  /** Add the view controls over its top right; returns the function that syncs their state. */
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
    const network = () => view as Network
    const projections =
      kind === 'network'
        ? PROJECTIONS.map(({ value, label, icon }) => ({
            value,
            control: button(icon, label, () => networkModule!.setProjection(network(), value)),
          }))
        : []
    const orbiting = kind === 'network' ? button('orbit', 'Auto-rotate', orbit) : undefined
    button('fit', 'Fit view', () => view?.fit(undefined, { animate: true }))
    host.append(bar)
    return () => {
      if (!view || kind !== 'network') return
      const { camera, projections: offered } = network()
      for (const { value, control } of projections) {
        control.setAttribute('aria-pressed', String(camera.projection === value))
        control.disabled = !offered[value] || (value === 'globe' && !geographic)
      }
      orbiting!.setAttribute('aria-pressed', String(camera.orbit === true))
    }
  }
  function connect(mounted: Network | Diagram) {
    // Both renderers emit these events; the union's `on` overloads are not callable.
    const events = mounted as Network
    events.on('error', (reason) => bridge.report(reason))
    events.on('frame', () => {
      if (!canvas.dataset.rendered) {
        mark('canvas:frame')
        canvas.dataset.rendered = 'true'
        fallback.hidden = true
        host.setAttribute('aria-busy', 'false')
        if (!host.querySelector('.toolbar')) sync = toolbar()
        sync()
        // The case is on screen: add its labels, and the borders paint asks for.
        labelled = true
        if (kind === 'network') paint()
      }
    })
    events.on('camera', (camera) => {
      sync()
      clearTimeout(saving)
      saving = setTimeout(() => {
        bridge.save({ uri: state.uri, camera })
        bridge.send({ kind: 'camera', camera })
      }, SAVE_MS)
    })
    // Open where the view was left; frame a case seen for the first time whole.
    const saved = bridge.state<{ uri?: string; camera?: unknown }>({})
    const camera = restore ?? (saved.uri === state.uri ? saved.camera : undefined)
    restore = undefined
    if (camera) mounted.set({ camera: camera as never })
    else {
      const off = events.on('frame', () => {
        off()
        if (view === mounted) mounted.fit(undefined, { animate: false })
      })
    }
  }
  async function render() {
    if (!rows || closed) return
    if (rendering) {
      queued = true
      return
    }
    rendering = true
    try {
      const [gpu] = await Promise.all([owner.get(lost), rendererReady])
      mark('canvas:gpu')
      if (closed) return
      if (kind === 'network') {
        if (!networkModule || !networkStyles) return
        mark('canvas:module')
        geographic = networkModule.isGeographic(rows, places)
        if (!view) {
          preferredProjection = networkModule.projectionOf(
            state.settings?.['network.camera.projection'] ?? 'flat',
            geographic,
          )
          const first = networkConfig()
          view = networkModule.mountNetwork(
            gpu,
            canvas,
            { ...first, camera: { projection: preferredProjection, orbit: false, fit: true } },
            () => state,
            select,
            open,
          )
          drawn = first
          connect(view)
        }
      } else {
        if (!diagramModule || !diagramStyles) return
        if (!diagramModule.diagrammed(rows)) {
          drop()
          fallback.hidden = false
          fallbackText.textContent =
            'This case has no directed signal components. Use Network to inspect its electrical topology.'
          host.setAttribute('aria-busy', 'false')
          return
        }
        if (!view) {
          const first = diagramConfig()
          view = diagramModule.mountDiagram(
            gpu,
            canvas,
            first,
            () => state,
            select,
            open,
            bridge.report,
          )
          drawn = first
          connect(view)
          // A large diagram takes a while to lay out.
          fallbackText.textContent = 'Arranging the diagram…'
        }
      }
      mark('canvas:mounted')
      view.set({ at: clock.now() })
      paint()
      mark('canvas:styled')
      selection(true)
    } finally {
      rendering = false
      if (queued && !closed) {
        queued = false
        void render().catch(error)
      }
    }
  }
  // Paint at the playhead. A network holding a window of the run asks for the times ahead before
  // the playhead runs out of them.
  const clock = createClock((t) => {
    if (!shown) return
    view?.set({ at: t })
    if (kind !== 'network' || !held || asked) return
    if (t >= held.from && (held.to === undefined || t <= held.to - 1)) return
    asked = true
    bridge.send({ kind: 'window', bounds: [t - 1, t + 4] })
  })
  receive((next, begin, base) => {
    mark('canvas:data')
    data = next
    rows = base
    held = begin.held
    asked = false
    const placed = kind === 'network' ? begin.placement : begin.presentation
    if (placed) places = placed
    if (begin.revision.version === state.summary?.version) void render().catch(error)
  }, error)
  bridge.on((message) => {
    if (message.kind === 'begin') mark('canvas:begin')
    else if (message.kind === 'state') {
      state = merged(state, message.state)
      canvas.setAttribute(
        'aria-label',
        state.diagramEditing
          ? 'Diagram editing. Drag ports to wire and blocks to place. Right-click for actions.'
          : hint,
      )
      say()
      selection()
      paint()
    } else if (message.kind === 'action') {
      if (message.command === 'shown') {
        shown = message.value === true
        view?.set({ paused: !shown || document.hidden, ...(shown && { at: clock.now() }) })
        return
      }
      if (message.command === 'reloadView') {
        drop()
        borderRequest = undefined
        return void render().catch(error)
      }
      if (!view) return
      if (message.command === 'fit') view.fit(undefined, { animate: true })
      else if (message.command === 'projection' && kind === 'network')
        networkModule!.setProjection(view as Network, message.value as Projection)
      else if (message.command === 'orbit') orbit()
      else if (message.command === 'neighborhood') {
        const item = view.selection[0]
        if (item) view.fit(view.neighborhood(item as never) as never, { animate: true })
      }
      sync()
    }
  })
  const unwatch = watchTheme(paint)
  // Test and benchmark hooks: the view's counters plus its GPU's cumulative work, which the
  // benchmarks hold to tests/benchmarks/work.json.
  ;(window as { gridkitStats?: () => unknown }).gridkitStats = () =>
    view && { ...view.stats(), ...owner.gpu?.stats() }
  // Where an element drew in the latest frame, so tests can read the color and height its fields
  // map to.
  ;(window as { gridkitLocate?: (id: string) => unknown }).gridkitLocate = (id) => {
    const item =
      kind === 'network' && view ? networkModule?.networkItem(view as Network, { id }) : undefined
    return item ? (view as Network).locate(item) : null
  }
  document.addEventListener('visibilitychange', () =>
    view?.set({ paused: !shown || document.hidden }),
  )
  window.addEventListener('pagehide', () => {
    closed = true
    clearTimeout(saving)
    unwatch()
    clock.stop()
    view?.destroy()
    view = undefined
    owner.dispose()
  })
  bridge.send({ kind: 'ready' })
}
boot()
