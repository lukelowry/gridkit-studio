/** The Network and Diagram editors: one canvas filling the editor, drawn straight from the case the
 *  extension streams. Framework-free, so nothing stands between opening a case and its first frame. */

import './styles/index.css'
import './styles/canvas.css'

import type { Diagram } from '@latkit/diagram'
import type { Data, FieldValues } from '@latkit/model'
import type { Network, Projection } from '@latkit/network'

import type { Begin, Element, ViewState } from '../shared/messages.js'
import { bridge, merged } from './bridge.js'
import { createClock } from './clock.js'
import { CanvasGpu } from './gpu.js'
import { loadBorders } from './network/borders.js'
import { receive } from './stream.js'
import { appearance, watchTheme } from './theme.js'
import { icon, type IconName } from './ui/glyphs.js'

/** How long the camera rests before its framing is saved. */
const SAVE_MS = 200
/** A GPU lost again this soon after it was replaced is not replaced a second time. */
const RECOVER_MS = 10000

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
  const title = kind === 'network' ? 'Network' : 'Diagram'
  const hint = title + ' view. Right-click an element for actions.'
  document.getElementById('app')!.innerHTML =
    '<main class="canvas-host" aria-busy="true"><div class="canvas-host__fault" hidden></div><canvas class="canvas-host__canvas" tabindex="0"></canvas><div class="canvas-host__fallback c-empty" role="status"><p class="c-empty__text">Loading case…</p></div></main>'
  const host = document.querySelector<HTMLElement>('.canvas-host')!
  const canvas = host.querySelector('canvas')!
  const fallback = host.querySelector<HTMLElement>('.canvas-host__fallback')!
  const notice = host.querySelector<HTMLElement>('.canvas-host__fault')!
  canvas.setAttribute('aria-label', hint)
  canvas.addEventListener('contextmenu', (event) => event.stopPropagation())

  const owner = new CanvasGpu()
  let networkModule: typeof import('./network/network.js') | undefined
  let networkStyles: typeof import('./network/style.js') | undefined
  let diagramModule: typeof import('./diagram/diagram.js') | undefined
  let diagramStyles: typeof import('./diagram/style.js') | undefined
  /** The case, and the case with the samples of the run on show. */
  let rows: Data | undefined
  let data: Data | undefined
  /** Whether the case's rows changed since the view last drew them. */
  let rebased = false
  let view: Network | Diagram | undefined
  let state: ViewState = {}
  /** The revision the case on hand was streamed for, and the times of the run it holds. */
  let revision = 0
  let held: Begin['held']
  /** Whether the view asked for other times of the run and has yet to hold them. */
  let asked = false
  let places: Record<string, FieldValues> = {}
  let closed = false
  /** Whether VS Code shows the view; a hidden one keeps its webview and stands still. */
  let shown = true
  let rendering = false
  let queued = false
  let geographic = false
  let borders: Data | null = null
  let borderRequest: Promise<void> | undefined
  /** The selection on show, and the one this view made itself, which it does not travel to. */
  let selectionKey = ''
  let own = ''
  let preferredProjection: Projection | undefined
  /** A problem the renderer met, said over the canvas until it draws again. */
  let fault: string | null = null
  /** Where the camera was when the GPU stopped, and when one was last replaced. */
  let restore: unknown
  let recovered = -Infinity
  let saving: ReturnType<typeof setTimeout> | undefined
  let sync = () => {}

  const keyOf = (element: Element | undefined) => (element?.id ?? '') + ':' + (element?.field ?? '')
  /** Say the newest problem, or that the case on show is not the one being typed. */
  const say = () => {
    const stale = !!state.stale && !!state.summary
    const problem = fault ?? state.error
    notice.hidden = !problem && !stale
    notice.classList.toggle('canvas-host__fault--warn', !problem)
    notice.setAttribute('role', problem ? 'alert' : 'status')
    notice.textContent =
      problem ??
      'Source is updating or contains errors. Showing the last valid revision; editing is paused.'
    if (!state.summary && state.error) {
      fallback.hidden = true
      host.setAttribute('aria-busy', 'false')
    } else if (!canvas.dataset.rendered && !state.error) {
      fallback.hidden = false
    }
  }
  const error = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (canvas.dataset.rendered) fault = message
    else {
      fallback.hidden = false
      fallback.firstElementChild!.textContent = `The ${kind} could not be drawn. ${message}`
      fallback.setAttribute('role', 'alert')
    }
    host.setAttribute('aria-busy', 'false')
    say()
    bridge.send({ kind: 'error', message })
  }
  const drop = () => {
    view?.destroy()
    view = undefined
    delete canvas.dataset.rendered
  }
  // A lost GPU is replaced once, the view drawn again where its camera was.
  const lost = () => {
    restore = view?.camera
    drop()
    if (performance.now() - recovered < RECOVER_MS) return error('WebGPU device lost.')
    recovered = performance.now()
    void render().catch(error)
  }
  // Load independent renderer resources while the worker prepares the case.
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
    own = keyOf(element ?? undefined)
    bridge.send({ kind: 'select', element })
  }
  const open = (element: Element) => {
    select(element)
    bridge.command('elementSource')
  }
  /** The style of the case on show, as the settings, bindings, and run now have it. */
  const diagramPatch = () => diagramStyles!.diagramStyle(rows!, state, places)
  const networkPatch = () =>
    networkStyles!.networkStyle(
      rows!,
      data!,
      state,
      geographic,
      borders,
      // Colors span the whole run once all of it is held and no more is coming.
      held === undefined && state.run?.state !== 'running',
    )
  /** Borders load after the first frame: decoration never holds up the case. */
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
      .catch((reason) => {
        bridge.send({ kind: 'error', message: 'Map boundaries: ' + String(reason) })
      })
  }
  function paint() {
    if (!view || !rows || !data || closed) return
    appearance(state.settings)
    try {
      view.set((kind === 'diagram' ? diagramPatch() : networkPatch()) as never)
    } catch (reason) {
      return error(reason)
    }
    if (canvas.dataset.rendered) decorate()
    if (kind !== 'network') return
    // A preference change applies once; ordinary styling never resets navigation.
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
    if (!force && key === selectionKey) return
    selectionKey = key
    try {
      const item = state.selection
        ? kind === 'diagram'
          ? diagramModule!.diagramItem(view as Diagram, state.selection)
          : networkModule!.networkItem(view as Network, state.selection)
        : undefined
      view.select((item ? [item] : []) as never)
      if (item && state.navigate && key !== own) view.reveal(item as never)
    } catch {
      /* A newer document projection can supersede the selection. */
    }
  }
  /** The view's controls, over its top right: on the network, its projections (each offered only
   *  where the case can be seen so) and Auto-rotate; on either view, Fit. */
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
    const orbit =
      kind === 'network'
        ? button('orbit', 'Auto-rotate', () => {
            if (state.settings?.['accessibility.motion'] !== 'reduce')
              network().set({ camera: { orbit: !network().camera.orbit } })
          })
        : undefined
    button('fit', 'Fit view', () => view?.fit(undefined, { animate: true }))
    host.append(bar)
    return () => {
      if (!view || kind !== 'network') return
      const { camera, projections: offered } = network()
      for (const { value, control } of projections) {
        control.setAttribute('aria-pressed', String(camera.projection === value))
        control.disabled = !offered[value] || (value === 'globe' && !geographic)
      }
      orbit!.setAttribute('aria-pressed', String(camera.orbit === true))
    }
  }
  function connect(shown: Network | Diagram) {
    const events = shown as Network
    events.on('error', error)
    events.on('frame', () => {
      if (!canvas.dataset.rendered) {
        mark('canvas:frame')
        canvas.dataset.rendered = 'true'
        fallback.hidden = true
        host.setAttribute('aria-busy', 'false')
        if (!host.querySelector('.toolbar')) sync = toolbar()
        sync()
        decorate()
      }
      if (fault !== null) {
        fault = null
        say()
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
    // The view opens where it was left; a case seen for the first time is framed whole.
    const saved = bridge.state<{ uri?: string; camera?: unknown }>({})
    const camera = restore ?? (saved.uri === state.uri ? saved.camera : undefined)
    restore = undefined
    if (camera) shown.set({ camera: camera as never })
    else {
      const off = events.on('frame', () => {
        off()
        if (view === shown) shown.fit(undefined, { animate: false })
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
        const drawn = networkModule.networkData(rows, places)
        // Samples arriving change how the case is styled, not what is drawn.
        if (view) {
          if (rebased) (view as Network).set(networkModule.rebase(drawn, networkPatch()))
        } else {
          preferredProjection = networkModule.projectionOf(
            state.settings?.['network.camera.projection'] ?? 'flat',
            geographic,
          )
          view = networkModule.mountNetwork(
            gpu,
            canvas,
            drawn,
            {
              ...networkPatch(),
              camera: { projection: preferredProjection, orbit: false, fit: true },
            },
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
          fallback.firstElementChild!.textContent =
            'This case has no directed signal components. Use Network to inspect its electrical topology.'
          host.setAttribute('aria-busy', 'false')
          return
        }
        if (view) {
          if (rebased) (view as Diagram).set({ source: rows, ...diagramPatch() })
        } else {
          view = diagramModule.mountDiagram(
            gpu,
            canvas,
            rows,
            diagramPatch(),
            () => state,
            select,
            open,
          )
          connect(view)
          // A large diagram is a while in its layout: say so, where the case was loading.
          fallback.firstElementChild!.textContent = 'Arranging the diagram…'
        }
      }
      rebased = false
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
  // Every view of the case paints at the playhead. A network holding a window of the run asks for
  // the times ahead before the playhead runs out of them.
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
    rebased ||= base !== rows
    rows = base
    held = begin.held
    asked = false
    revision = begin.revision.version
    const placed = kind === 'network' ? begin.placement : begin.presentation
    if (placed) places = placed
    if (revision === state.summary?.version) void render().catch(error)
  }, error)
  bridge.on((message) => {
    if (message.kind === 'begin') mark('canvas:begin')
    else if (message.kind === 'state') {
      const before = state
      state = merged(state, message.state)
      canvas.setAttribute(
        'aria-label',
        state.diagramEditing
          ? 'Diagram editing. Drag ports to wire and blocks to place. Right-click for actions.'
          : hint,
      )
      say()
      selection()
      if (
        before.settings !== state.settings ||
        before.diagramEditing !== state.diagramEditing ||
        before.stale !== state.stale ||
        before.writable !== state.writable ||
        before.run?.id !== state.run?.id ||
        before.run?.state !== state.run?.state ||
        JSON.stringify(before.bindings) !== JSON.stringify(state.bindings)
      )
        paint()
    } else if (message.kind === 'action') {
      if (message.command === 'error') return error(message.value)
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
      else if (message.command === 'orbit' && kind === 'network') {
        const network = view as Network
        if (state.settings?.['accessibility.motion'] !== 'reduce')
          network.set({ camera: { orbit: !network.camera.orbit } })
      } else if (message.command === 'neighborhood') {
        const item = view.selection[0]
        if (item) view.fit(view.neighborhood(item as never) as never, { animate: true })
      }
      sync()
    }
  })
  const unwatch = watchTheme(paint)
  // Tests and the performance command read what the renderer drew; nothing is kept for them.
  ;(window as { gridkitStats?: () => unknown }).gridkitStats = () => view?.stats()
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
