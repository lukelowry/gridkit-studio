/** The Network and Diagram editors, framework-free so nothing delays a case's first frame. */

import './styles/index.css'
import './styles/canvas.css'

import type { Diagram } from '@latkit/diagram'
import type { Positions } from '@latkit/gpu'
import { type Data, type Item, itemId } from '@latkit/model'
import type { Network, Projection } from '@latkit/network'

import type { Begin, Element, ViewState } from '../shared/messages.js'
import { bridge, merged } from './bridge.js'
import { createClock } from './clock.js'
import { CanvasGpu, RECOVER_MS } from './gpu.js'
import { loadBorders } from './network/borders.js'
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
    '<main class="canvas-host" aria-busy="true"><canvas class="canvas-host__canvas" tabindex="0"></canvas><div class="canvas-host__fallback c-empty" role="status"><p class="c-empty__text">Loading case…</p></div></main>'
  const host = document.querySelector<HTMLElement>('.canvas-host')!
  const canvas = host.querySelector('canvas')!
  const fallback = host.querySelector<HTMLElement>('.canvas-host__fallback')!
  const fallbackText = fallback.firstElementChild!
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
  let received: Begin | undefined
  let view: Network | Diagram | undefined
  let state: ViewState = {}
  /** The times of the run the case holds; undefined when it holds all of them. */
  let held: Begin['held']
  /** Whether the view has asked for other times of the run and not yet received them. */
  let asked = false
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
  let locatedRows: Data | undefined
  let styling = 0
  /** The shown selection and what stands for it, and the last one this view made, which it does
   *  not reveal. */
  let selectionKey = ''
  let anchorKey = ''
  let own = ''
  let preferredProjection: Projection | undefined
  /** The camera to restore after the GPU is lost, and when the GPU was last replaced. */
  let restore: unknown
  let recovered = -Infinity
  let saving: ReturnType<typeof setTimeout> | undefined
  let sync = () => {}

  const keyOf = (element?: Element | null) => (element?.id ?? '') + ':' + (element?.field ?? '')
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
    bridge.report(reason)
  }
  const drop = () => {
    view?.destroy()
    view = undefined
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
  const networkConfig = () =>
    networkStyles!.networkConfig(rows!, data!, state, geographic, borders, labelled)
  const diagramConfig = () => diagramStyles!.diagramConfig(rows!, state, presented)
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
    if (!view || !rows || !data || closed) return
    // State arrives before the matching row stream. Keep the last valid frame until both
    // refer to the same revision, rather than applying new row selections to old tables.
    if (received?.revision.version !== state.summary?.version) return
    appearance(state.settings)
    try {
      if (kind === 'diagram') (view as Diagram).set(diagramConfig(), { replace: true })
      else (view as Network).set(networkConfig(), { replace: true })
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
    events.on('error', (reason) => bridge.report(reason))
    events.on('frame', () => {
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
        if (locatedRows !== rows) {
          geographic = networkModule.isGeographic(rows)
          locatedRows = rows
        }
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
    received = begin
    const changedRows = rows !== base
    rows = base
    held = begin.held
    asked = false
    if (begin.presentation) presented = begin.presentation
    if (begin.revision.version === state.summary?.version) {
      if (!view || changedRows) void render().catch(error)
      else paint()
    }
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
  // benchmarks hold to tests/benchmarks/work.json.
  ;(window as { gridkitStats?: () => unknown }).gridkitStats = () =>
    view && { ...view.stats(), ...owner.gpu?.stats() }
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
    unwatch()
    clock.stop()
    view?.destroy()
    view = undefined
    owner.dispose()
  })
  bridge.send({ kind: 'ready' })
}
boot()
