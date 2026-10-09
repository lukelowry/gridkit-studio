/** The Network and Diagram editors, framework-free so nothing delays a case's first frame. */

import './styles/index.css'
import './styles/canvas.css'

import type { Diagram } from '@latkit/diagram'
import type { Positions } from '@latkit/gpu'
import { type Data, type Item, itemId } from '@latkit/model'
import type { Network, Projection } from '@latkit/network'

import type { Element, ViewState } from '../shared/messages.js'
import { bridge, merged } from './bridge.js'
import { createClock } from './clock.js'
import { CanvasGpu } from './gpu.js'
import { loadBorders } from './network/borders.js'
import { Recovery } from './recovery.js'
import { current as currentRows, drawable, Rows, type Snapshot, staticNeeds } from './rows.js'
import { networkNeeds, Samples } from './samples.js'
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
    '<main class="canvas-host" aria-busy="true"><canvas class="canvas-host__canvas" tabindex="0"></canvas><div class="canvas-host__fallback c-empty" role="status"><p class="c-empty__text">Loading case…</p></div><div class="canvas-host__status" role="status" hidden></div></main>'
  const host = document.querySelector<HTMLElement>('.canvas-host')!
  const canvas = host.querySelector('canvas')!
  const fallback = host.querySelector<HTMLElement>('.canvas-host__fallback')!
  const fallbackText = fallback.firstElementChild!
  const availability = host.querySelector<HTMLElement>('.canvas-host__status')!
  let buffering: ReturnType<typeof setTimeout> | undefined
  canvas.setAttribute('aria-label', hint)
  canvas.addEventListener('contextmenu', (event) => event.stopPropagation())

  const owner = new CanvasGpu()
  let networkModule: typeof import('./network/network.js') | undefined
  let networkStyles: typeof import('./network/style.js') | undefined
  let diagramModule: typeof import('./diagram/diagram.js') | undefined
  let diagramStyles: typeof import('./diagram/style.js') | undefined
  let view: Network | Diagram | undefined
  let state: ViewState = {}
  /** The case's rows, as last sent. */
  let snapshot: Snapshot | undefined
  /** The rows with the samples the view holds, which it draws; and those it last drew. */
  let data: Data | undefined
  let painted: Data | undefined
  let presentedAt: number | undefined
  /** How many times rows or samples have come, and how many the last frame drew. */
  let received = 0
  let drawn: number | undefined
  const samples = new Samples({
    request: (input, signal) => bridge.request('samples', input, signal),
    // Samples draw when the time shown needs them.
    changed: () => {
      received++
      show(clock.now())
    },
    report: (reason) => bridge.report(reason),
  })
  /** Where the case saves its diagram blocks. */
  let presented: Record<string, Positions> = {}
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
  /** Topology is unchanged by sampled frames. Do not rescan coordinates on every update. */
  let located: Data | undefined
  let styling = 0
  /** The shown selection and what stands for it, and the last one this view made, which it does
   *  not reveal. */
  let selectionKey = ''
  let anchorKey = ''
  let own = ''
  let preferredProjection: Projection | undefined
  /** The camera to restore after a renderer or GPU failure. */
  let restore: unknown
  let saving: ReturnType<typeof setTimeout> | undefined
  let sync = () => {}

  const keyOf = (element?: Element | null) => (element?.id ?? '') + ':' + (element?.field ?? '')
  /** Whether rows are of the case to draw. The Network waits for the static fields its mappings
   *  read; the Diagram maps nothing, so its rows are enough. */
  const current = (rows: Snapshot | undefined) =>
    kind === 'network' ? drawable(rows, state) : currentRows(rows, state) && !state.stale
  /** A case that has never read draws nothing and stops waiting; one that stops reading keeps its
   *  last valid revision. Neither says so here: Problems lists why, as for any file. */
  const say = () => {
    if (!state.summary && state.error) {
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
    bridge.report(reason, {
      view: kind,
      phase: 'draw',
      received: drawn,
      results: state.results?.id,
      at: clock.now(),
      samples: samples.stats(),
      bindings: state.bindings,
      rows: snapshot?.revision,
      summary: state.summary && { uri: state.summary.uri, version: state.summary.version },
    })
  }
  const drop = () => {
    view?.destroy()
    view = undefined
    labelled = false
    delete canvas.dataset.rendered
  }
  const recovery = new Recovery(() => {
    restore = view?.camera ?? restore
    drop()
    void render().catch((reason) => recovery.fail(reason))
  }, error)
  /** Replace a lost GPU and redraw where the camera was. */
  const lost = (reason: unknown) => {
    restore = view?.camera
    drop()
    recovery.fail(reason)
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
  /** The item the view draws for `element`; undefined when it draws none, or not yet. */
  const drawnItem = (element: Element) => {
    if (!view) return undefined
    try {
      return kind === 'diagram'
        ? diagramModule!.diagramItem(view as Diagram, element)
        : networkModule!.networkItem(view as Network, element)
    } catch {
      // A newer document projection can supersede the element.
      return undefined
    }
  }
  const networkConfig = (rows: Data) =>
    networkStyles!.networkConfig(rows, data ?? rows, state, geographic, borders, labelled)
  const diagramConfig = ({ data }: Snapshot) => diagramStyles!.diagramConfig(data, state, presented)
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
  /** Give the view its whole config; it keeps what it has read, scaled, laid out, and uploaded
   *  for every value that did not change, and resets what the config leaves out. */
  function paint() {
    if (styling || closed) return
    styling = requestAnimationFrame(() => {
      styling = 0
      paintNow()
    })
  }
  function paintNow() {
    if (!view || !snapshot || closed) return
    // State arrives before the matching rows. Keep the last valid frame until both refer to the
    // same revision, rather than applying new row selections to old tables.
    if (!current(snapshot)) return
    const at = clock.now()
    if (kind === 'network' && !ready(at)) return
    appearance(state.settings)
    try {
      if (kind === 'diagram') (view as Diagram).set(diagramConfig(snapshot), { replace: true })
      else (view as Network).set({ ...networkConfig(snapshot.data), at }, { replace: true })
      painted = data
      drawn = received
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
    if (!view || !current(snapshot)) return
    const key = keyOf(state.selection)
    const anchors = state.anchors?.join('\n') ?? ''
    const moved = key !== selectionKey || anchors !== anchorKey
    if (!force && !moved) return
    selectionKey = key
    anchorKey = anchors
    try {
      const item = state.selection && drawnItem(state.selection)
      // An element the view does not draw shows as the elements its ports reach.
      const items = item ? [item] : (state.anchors ?? []).flatMap((id) => drawnItem({ id }) ?? [])
      view.select(items as never)
      // Bring a selection made in another view into this one. Only a new selection moves the
      // camera, and only when it lies outside the view.
      if (items[0] && moved && key !== own) view.reveal(items[0] as never)
    } catch {
      /* A newer document projection can supersede the selection. */
    }
  }
  /** Add the Network's projections and rotation over its top right; returns the function that
   *  syncs their state. Fit is the editor's own title action. */
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
    const projections = PROJECTIONS.map(({ value, label, icon }) => ({
      value,
      control: button(icon, label, () => networkModule!.setProjection(network(), value)),
    }))
    const orbiting = button('orbit', 'Auto-rotate', orbit)
    host.append(bar)
    return () => {
      if (!view) return
      const { camera, projections: offered } = network()
      for (const { value, control } of projections) {
        control.setAttribute('aria-pressed', String(camera.projection === value))
        control.disabled = !offered[value] || (value === 'globe' && !geographic)
      }
      orbiting.setAttribute('aria-pressed', String(camera.orbit === true))
    }
  }
  function connect(mounted: Network | Diagram) {
    // Both renderers emit these events; the union's `on` overloads are not callable.
    const events = mounted as Network
    events.on('error', (reason) => recovery.fail(reason))
    events.on('frame', (frame) => {
      presentedAt = frame.at
      recovery.presented()
      if (!canvas.dataset.rendered) {
        mark('canvas:frame')
        canvas.dataset.rendered = 'true'
        fallback.hidden = true
        host.setAttribute('aria-busy', 'false')
        if (kind === 'network' && !host.querySelector('.toolbar')) sync = toolbar()
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
    if (!snapshot || closed) return
    if (rendering) {
      queued = true
      return
    }
    rendering = true
    try {
      const [gpu] = await Promise.all([owner.get(lost), rendererReady])
      mark('canvas:gpu')
      if (closed || !snapshot || !current(snapshot)) return
      if (kind === 'network') {
        const at = clock.now()
        if (!ready(at) || !networkModule || !networkStyles) return
        mark('canvas:module')
        if (located !== snapshot.data) {
          geographic = networkModule.isGeographic(snapshot.data)
          located = snapshot.data
        }
        if (!view) {
          preferredProjection = networkModule.projectionOf(
            state.settings?.['network.camera.projection'] ?? 'flat',
            geographic,
          )
          const first = { ...networkConfig(snapshot.data), at }
          view = networkModule.mountNetwork(
            gpu,
            canvas,
            { ...first, camera: { projection: preferredProjection, orbit: false, fit: true } },
            () => state,
            select,
            open,
          )
          connect(view)
        }
      } else {
        if (!diagramModule || !diagramStyles) return
        // A case with no directed signal components has nothing to draw here.
        const empty = !diagramModule.diagrammed(snapshot.data)
        host.toggleAttribute('data-empty', empty)
        if (empty) {
          drop()
          fallback.hidden = true
          host.setAttribute('aria-busy', 'false')
          return
        }
        if (!view) {
          const first = diagramConfig(snapshot)
          view = diagramModule.mountDiagram(
            gpu,
            canvas,
            first,
            () => state,
            select,
            open,
            bridge.report,
          )
          connect(view)
          // A large diagram takes a while to lay out.
          fallbackText.textContent = 'Arranging the diagram…'
        }
      }
      mark('canvas:mounted')
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
  /** Whether the Network holds what it maps at `at`: rows of this revision, and the samples its
   *  mappings read over that time. */
  function covered(at: number): boolean {
    if (!drawable(snapshot, state)) return false
    const { results, summary } = state
    if (!results?.frames || results.fingerprint !== summary?.fingerprint) return true
    if (at < results.domain[0] || at > results.domain[1]) return false
    return networkNeeds(state).every(({ selection }) =>
      samples.covers(selection.from, selection.select[0]!, [at, at]),
    )
  }
  /** Whether the Network can draw `at`. It asks for the samples that time needs, then those
   *  nearest it, and draws from the samples it holds once they cover it. */
  function ready(at: number): boolean {
    const { results } = state
    const unavailable = results && (at < results.domain[0] || at > results.domain[1])
    const played = clock.state
    const travel = played.status === 'playing' ? played.rate * played.direction : 0
    samples.want(results, networkNeeds(state), unavailable ? undefined : [at, at], { at, travel })
    if (snapshot) data = samples.data(snapshot.data)
    const available = covered(at)
    const status = unavailable ? 'unavailable' : available ? 'ready' : 'buffering'
    if (host.dataset.availability !== status) {
      host.setAttribute('aria-busy', String(status === 'buffering'))
      host.dataset.availability = status
      clearTimeout(buffering)
      availability.hidden = true
      if (status !== 'ready')
        buffering = setTimeout(() => {
          availability.textContent =
            status === 'buffering' ? 'Loading samples…' : 'No recorded sample at this time.'
          availability.hidden = !canvas.dataset.rendered
        }, 150)
    }
    return available
  }
  /** Show time `t`. Source and time change together. An uncovered seek keeps the last valid frame
   *  visible. The Diagram maps no samples, so time leaves it as it is. */
  function show(t: number) {
    if (!shown || kind === 'diagram' || !ready(t)) return
    if (view && painted === data) view.set({ at: t })
    else if (!view) void render().catch(error)
    // Pages reach the view as time does, this frame; a restyle waits for the next.
    else paintNow()
  }
  const clock = createClock(show)
  const rows = new Rows({
    request: (input, signal) => bridge.request('rows', input, signal),
    presentation: (revision, signal) => bridge.request('presentation', revision, signal),
    // Rows of the revision on show draw at once.
    changed: () => {
      mark('canvas:data')
      received++
      snapshot = rows.snapshot
      if (snapshot?.presentation) presented = snapshot.presentation
      if (current(snapshot)) void render().catch(error)
    },
    report: (reason) => bridge.report(reason),
  })
  bridge.on((message) => {
    if (message.kind === 'state') {
      state = merged(state, message.state)
      // The rows this state draws: a case read again is asked for once it reads.
      if (state.summary && !state.stale) {
        mark('canvas:begin')
        rows.want(
          { summary: state.summary },
          staticNeeds(state.summary, state.bindings, kind === 'network'),
          kind === 'diagram',
        )
      }
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
        view?.set({ paused: !shown || document.hidden })
        if (shown) paint()
        return
      }
      if (message.command === 'reloadView') {
        drop()
        borderRequest = undefined
        rows.retry()
        samples.retry()
        return void render().catch(error)
      }
      if (!view) return
      if (message.command === 'fit') view.fit(undefined, { animate: true })
      else if (message.command === 'projection' && kind === 'network')
        networkModule!.setProjection(view as Network, message.value as Projection)
      else if (message.command === 'orbit') orbit()
      else if (message.command === 'neighborhood') {
        // The action names its element: the selection it made may reach the view after it.
        const item =
          typeof message.value === 'string' ? drawnItem({ id: message.value }) : view.selection[0]
        if (item) view.fit(view.neighborhood(item as never) as never, { animate: true })
      }
      sync()
    }
  })
  const unwatch = watchTheme(paint)
  // Test and benchmark hooks: the view's counters plus its GPU's cumulative work, which the
  // benchmarks report beside their timings.
  ;(window as { gridkitStats?: () => unknown }).gridkitStats = () =>
    view && {
      ...view.stats(),
      ...owner.gpu?.stats(),
      at: presentedAt,
      requestedAt: clock.now(),
      received: drawn,
      samples: samples.stats(),
      availability: host.dataset.availability,
    }
  // What the view shows selected, and where its camera is, so tests can follow a selection made
  // in another view.
  ;(window as { gridkitSelection?: () => unknown }).gridkitSelection = () =>
    view && { ids: view.selection.map((item) => itemId(item as Item)), camera: view.camera }
  // Where an element, or one of its ports, drew in the latest frame, so tests can point at it and
  // read the color and height its fields map to.
  ;(window as { gridkitLocate?: (id: string, field?: string) => unknown }).gridkitLocate = (
    id,
    field,
  ) => {
    const item = drawnItem({ id, ...(field && { field }) })
    return item && view ? view.locate(item as never) : null
  }
  document.addEventListener('visibilitychange', () =>
    view?.set({ paused: !shown || document.hidden }),
  )
  window.addEventListener('pagehide', () => {
    closed = true
    cancelAnimationFrame(styling)
    clearTimeout(saving)
    clearTimeout(buffering)
    unwatch()
    clock.stop()
    recovery.dispose()
    view?.destroy()
    view = undefined
    owner.dispose()
  })
  bridge.send({ kind: 'ready' })
}
boot()
