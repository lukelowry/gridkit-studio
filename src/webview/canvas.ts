/** The Network and Diagram editors, framework-free so nothing delays a case's first frame. The
 *  canvas they share is here: its GPU, its view's lifetime, the rows it draws, selection and the
 *  camera. What each draws, and how, is its kind's. */

import './styles/index.css'
import './styles/canvas.css'

import { type Item, itemId } from '@latkit/model'
import type { Network } from '@latkit/network'

import type { Element, ViewState } from '../shared/messages.js'
import { bridge, merged } from './bridge.js'
import { diagram } from './diagram/kind.js'
import { CanvasGpu } from './gpu.js'
import type { Drawn, Host } from './kind.js'
import { network } from './network/kind.js'
import { Recovery } from './recovery.js'
import { Rows, type Snapshot } from './rows.js'
import { appearance, watchTheme } from './theme.js'

/** How long the camera rests before its framing is saved. */
const SAVE_MS = 200
/** What of the state a canvas draws from; the selection it shows apart. */
const DRAWN = [
  'summary',
  'settings',
  'bindings',
  'results',
  'diagramEditing',
  'writable',
  'stale',
] as const satisfies readonly (keyof ViewState)[]

const mark = (name: string) => {
  if (!performance.getEntriesByName(name).length) performance.mark(name)
}

function boot() {
  mark('canvas:boot')
  const name = document.body.dataset.kind
  if (name !== 'network' && name !== 'diagram') return
  const hint =
    (name === 'network' ? 'Network' : 'Diagram') + ' view. Right-click an element for actions.'
  document.getElementById('app')!.innerHTML =
    '<main class="canvas-host" aria-busy="true"><canvas class="canvas-host__canvas" tabindex="0"></canvas><div class="canvas-host__fallback c-empty" role="status"><p class="c-empty__text">Loading case…</p></div><div class="canvas-host__status" role="status" hidden></div></main>'
  const element = document.querySelector<HTMLElement>('.canvas-host')!
  const canvas = element.querySelector('canvas')!
  const fallback = element.querySelector<HTMLElement>('.canvas-host__fallback')!
  canvas.setAttribute('aria-label', hint)
  canvas.addEventListener('contextmenu', (event) => event.stopPropagation())

  const owner = new CanvasGpu()
  let view: Drawn | undefined
  let state: ViewState = {}
  /** The case's rows, as last sent. */
  let snapshot: Snapshot | undefined
  let presentedAt: number | undefined
  /** How many times rows or samples have come, and how many the last frame drew. */
  let received = 0
  let drawn: number | undefined
  let closed = false
  /** Whether VS Code shows the view; a hidden view keeps its webview but pauses. */
  let shown = true
  let rendering = false
  let queued = false
  let styling = 0
  /** The shown selection and what stands for it, and the last one this view made, which it does
   *  not reveal. */
  let selectionKey = ''
  let anchorKey = ''
  let own = ''
  /** The camera to restore after a renderer or GPU failure. */
  let restore: unknown
  let saving: ReturnType<typeof setTimeout> | undefined

  const keyOf = (element?: Element | null) => (element?.id ?? '') + ':' + (element?.field ?? '')
  /** A case that has never read draws nothing and stops waiting; one that stops reading keeps its
   *  last valid revision. Neither says so here: Problems lists why, as for any file. */
  const say = () => {
    if (!state.summary && state.error) {
      fallback.hidden = true
      element.setAttribute('aria-busy', 'false')
    } else if (!canvas.dataset.rendered) {
      fallback.hidden = false
    }
  }
  /** The view cannot draw: it stops waiting, and the extension says why. */
  const error = (reason: unknown) => {
    if (!canvas.dataset.rendered) fallback.hidden = true
    element.setAttribute('aria-busy', 'false')
    bridge.report(reason, {
      view: name,
      phase: 'draw',
      received: drawn,
      results: state.results?.id,
      ...kind.stats(),
      bindings: state.bindings,
      rows: snapshot?.revision,
      summary: state.summary && { uri: state.summary.uri, version: state.summary.version },
    })
  }
  const drop = () => {
    view?.destroy()
    kind.unmount()
    view = undefined
    delete canvas.dataset.rendered
  }
  const recovery = new Recovery(() => {
    restore = view?.camera ?? restore
    drop()
    void render().catch((reason) => recovery.fail(reason))
  }, error)
  /** Replace a lost GPU and redraw where the camera was. */
  const lost = (reason: unknown) => {
    restore = view?.camera ?? restore
    drop()
    recovery.fail(reason)
  }
  const select = (element: Element | null) => {
    own = keyOf(element)
    bridge.send({ kind: 'select', element })
  }
  const open = (element: Element) => {
    select(element)
    bridge.command('elementSource')
  }
  const host: Host = {
    element,
    canvas,
    state: () => state,
    rows: () => snapshot,
    view: () => view,
    shown: () => shown,
    rendered: () => !!canvas.dataset.rendered,
    closed: () => closed,
    received: () => void received++,
    // A restart waiting out its backoff is the one that draws again: the clock does not.
    render: () => {
      if (!recovery.pending) void render().catch(error)
    },
    paint,
    paintNow,
    drop,
    settle() {
      fallback.hidden = true
      element.setAttribute('aria-busy', 'false')
    },
    waiting: (text) => (fallback.firstElementChild!.textContent = text),
    select,
    open,
    mark,
  }
  const kind = (name === 'network' ? network : diagram)(host)
  // The renderer loads while the worker prepares the case.
  void kind.loaded.then(() => mark('canvas:loaded'), error)
  void owner.get(lost).then(() => mark('canvas:device'), error)

  /** The item the view draws for `element`; undefined when it draws none, or not yet. */
  const drawnItem = (element: Element) => {
    if (!view) return undefined
    try {
      return kind.item(view, element)
    } catch {
      // A newer document projection can supersede the element.
      return undefined
    }
  }
  /** Give the view its whole config next frame. */
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
    if (!kind.current(snapshot) || !kind.ready()) return
    appearance(state.settings)
    try {
      kind.paint(view, snapshot)
      drawn = received
    } catch (reason) {
      return error(reason)
    }
    kind.painted(view)
  }
  function selection(force = false) {
    if (!view || !kind.current(snapshot)) return
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
  function connect(mounted: Drawn) {
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
        element.setAttribute('aria-busy', 'false')
        kind.presented(mounted)
      }
    })
    events.on('camera', (camera) => {
      kind.sync()
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
      const [gpu] = await Promise.all([owner.get(lost), kind.loaded])
      mark('canvas:gpu')
      if (closed || !snapshot || !kind.current(snapshot) || !kind.arrange(snapshot)) return
      if (!view) {
        view = kind.mount(gpu, snapshot)
        connect(view)
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
  // Rows of the revision on show draw at once.
  const rows = new Rows(bridge, () => {
    mark('canvas:data')
    received++
    snapshot = rows.snapshot
    if (kind.current(snapshot)) void render().catch(error)
  })
  bridge.on((message) => {
    if (message.kind === 'state') {
      const before = state
      state = merged(state, message.state)
      // The rows this state draws: a case read again is asked for once it reads.
      if (state.summary && !state.stale) {
        mark('canvas:begin')
        rows.want(
          { summary: state.summary },
          kind.needs(state.summary, state.bindings),
          kind.presentation,
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
      // Only what the view draws from restyles it: a selection, say, it shows on its own.
      if (DRAWN.some((key) => state[key] !== before[key])) paint()
    } else if (message.kind === 'shown') {
      shown = message.shown
      view?.set({ paused: !shown || document.hidden })
      if (shown) paint()
    } else if (message.kind === 'action') {
      if (message.command === 'reloadView') {
        recovery.reset()
        drop()
        kind.retry()
        rows.retry()
        return void render().catch(error)
      }
      if (!view) return
      if (message.command === 'fit') view.fit(undefined, { animate: true })
      else if (message.command === 'neighborhood') {
        // The action names its element: the selection it made may reach the view after it.
        const item =
          typeof message.value === 'string' ? drawnItem({ id: message.value }) : view.selection[0]
        if (item) view.fit(view.neighborhood(item as never) as never, { animate: true })
      } else kind.act(view, message.command, message.value)
      kind.sync()
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
      received: drawn,
      ...kind.stats(),
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
    unwatch()
    kind.dispose()
    recovery.dispose()
    drop()
    owner.dispose()
  })
  bridge.ready()
}
boot()
