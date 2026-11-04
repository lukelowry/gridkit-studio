/** The Network's page: the case on a latkit canvas. Source revisions and GPU resources have
 *  separate lifetimes. */
import './styles/index.css'
import './styles/canvas.css'

import type { Camera, Data, Gpu, Scene, Source } from 'latkit'

import type { Bindings } from '../shared/bindings.js'
import { type Entity, isEntity, networkRole } from '../shared/document.js'
import { quiet } from '../shared/errors.js'
import { revisionOf, type Summary, type ViewState } from '../shared/messages.js'
import { reader, TILTED } from '../shared/preferences.js'
import { bridge, merged } from './bridge.js'
import { createClock } from './clock.js'
import { saveImage, viewShot } from './export/image.js'
import { FrameReads, FrameWindow } from './frames.js'
import { ViewHost } from './host.js'
import { bindInteractions } from './interactions.js'
import { type Background, backgroundOf } from './maps.js'
import { nativeMenu } from './menu.js'
import { followPlayback } from './playback.js'
import { CaseProjection } from './projections.js'
import { asset, openGpu, startOver } from './runtime.js'
import { caseFit, sampledFields, sceneFields, sceneOf } from './scenes.js'
import { nativeTheme, theme, watchTheme } from './theme.js'
import { icon, type IconName } from './ui/glyphs.js'

const mark = (name: string) => {
  if (!performance.getEntriesByName(name).length) performance.mark(name)
}

function boot() {
  if (document.body.dataset.kind !== 'network') return
  mark('canvas:boot')
  document.getElementById('app')!.innerHTML =
    '<main class="canvas-host" aria-busy="true"><canvas class="canvas-host__canvas" tabindex="0"></canvas><div class="canvas-host__fallback c-empty" role="status"><p class="c-empty__text">Loading case…</p></div><div class="canvas-host__status" role="status" hidden></div></main>'
  const main = document.querySelector<HTMLElement>('.canvas-host')!
  const canvas = main.querySelector('canvas')!
  const fallback = main.querySelector<HTMLElement>('.canvas-host__fallback')!
  const attribution = main.querySelector<HTMLElement>('.canvas-host__status')!
  const toolbar = document.createElement('div')
  toolbar.className = 'toolbar'
  toolbar.dataset.testid = 'view-toolbar'
  toolbar.setAttribute('role', 'toolbar')
  toolbar.setAttribute('aria-label', 'Network display')
  const buttons = new Map<string, HTMLButtonElement>()
  for (const [label, glyph] of [
    ['Flat', 'projection-flat'],
    ['Tilt', 'projection-tilt'],
    ['Globe', 'projection-globe'],
    ['Auto-rotate', 'orbit'],
  ] as const) {
    const button = document.createElement('button')
    button.className = 'c-icon-btn'
    button.setAttribute('aria-label', label)
    button.title = label
    button.innerHTML = icon(glyph as IconName)
    button.addEventListener('click', () => {
      const values =
        label === 'Auto-rotate'
          ? { 'network.orbit': reader(state.settings).get('network.orbit') ? 0 : 8 }
          : {
              'network.projection': label === 'Globe' ? ('globe' as const) : ('mercator' as const),
              'network.tilt': label === 'Tilt' ? TILTED : 0,
            }
      bridge.send({ kind: 'display', values })
    })
    buttons.set(label, button)
    toolbar.append(button)
  }
  main.append(toolbar)
  canvas.setAttribute('aria-label', 'Network view. Right-click an element for actions.')
  canvas.addEventListener('contextmenu', (event) => event.stopPropagation())
  const cases = new CaseProjection()
  const reads = new FrameReads()
  /** The frames each mapped field of the results holds around the playhead, by `[table, field]`. */
  const windows = new Map<string, FrameWindow>()
  /** Lets go of an image being drawn once the page goes. */
  const page = new AbortController()
  let state: ViewState = {}
  let summary: Summary | undefined
  let host: ViewHost | undefined
  let gpu: Gpu | undefined
  let opening: Promise<Gpu> | undefined
  let epoch = 0
  let closed = false
  let shown = true
  let creating = false
  let restore: Camera | undefined
  let stops: Array<() => void> = []
  let playback: (() => void) | undefined
  let saving: ReturnType<typeof setTimeout> | undefined
  let own = ''
  let selected = ''
  let tilt: number | undefined
  let background: Background = { sources: [], marks: [] }
  let mapKey = ''
  let mapController: AbortController | undefined
  let received = 0
  let drawnBindings: Bindings = {}
  let heldFields = new Map<string, Set<string>>()
  const visible = () => shown && !document.hidden && !closed
  /** Says what the canvas frames once its camera and size rest: the page keeps the camera to open on
   *  again, and the extension the framing, for an export to frame what the user saw. A canvas out
   *  of sight frames nothing. */
  const framing = () => {
    clearTimeout(saving)
    saving = setTimeout(() => {
      const size = [canvas.clientWidth, canvas.clientHeight]
      if (!host || !size[0] || !size[1]) return
      const { camera } = host.view
      bridge.save({ uri: state.uri, camera })
      bridge.send({ kind: 'framing', framing: { camera, size } })
    }, 200)
  }
  const resizing = new ResizeObserver(framing)
  resizing.observe(canvas)
  const drop = () => {
    ++epoch
    restore = host?.view.camera ?? restore
    playback?.()
    playback = undefined
    for (const stop of stops) stop()
    stops = []
    host?.destroy()
    host = undefined
    tilt = undefined
  }
  /** latkit replaces a lost device itself; only once it stops does the page start over. A wait the
   *  view let go of, as it went, is no failure. */
  function fail(error: unknown) {
    if (quiet(error) || startOver(error)) return
    main.setAttribute('aria-busy', 'false')
    fallback.hidden = true
    bridge.report(error, { view: 'network', phase: 'draw' })
  }
  const clock = createClock(
    (at) => {
      prefetch(at)
      if (host && visible() && covered(at)) host.view.at = at
    },
    () => follow(),
  )

  function follow() {
    playback?.()
    playback = undefined
    if (!gpu || !host || !visible() || clock.state.status !== 'playing') return
    playback = followPlayback(
      gpu,
      () => (host && covered(clock.now()) ? [host.view] : []),
      () => {
        const at = clock.now()
        prefetch(at)
        return at
      },
    )
  }

  function sources(): Source[] {
    const data = cases.slot.current?.data
    return [
      ...(data ? [data] : []),
      ...background.sources,
      ...[...windows.values()].flatMap((window) => (window.data ? [window.data] : [])),
    ]
  }

  /** What the view draws now: the bindings whose fields it holds, and the map. */
  function scene(data: Data, summary: Summary): Scene {
    const settings = reader(state.settings)
    const requested = sceneFields(summary.definition, state.bindings)
    if (
      requested.every(({ table, fields }) =>
        fields.every((field) => heldFields.get(table)?.has(field)),
      )
    )
      drawnBindings = state.bindings ?? {}
    return sceneOf(data, summary.definition, settings, nativeTheme(settings, 'network'), {
      bindings: drawnBindings,
      results: state.results,
      sampled: (table, field) => windows.get(JSON.stringify([table, field]))?.data,
      background: background.marks,
    })
  }

  function paint() {
    const data = cases.slot.current?.data
    if (!host || !data || !summary) return
    const { view } = host
    const settings = reader(state.settings)
    view.sources = sources()
    host.scene = scene(data, summary)
    const projection =
      summary.definition.drawing.geographic && settings.get('network.projection') === 'globe'
        ? 'Globe'
        : settings.get('network.tilt') > 0
          ? 'Tilt'
          : 'Flat'
    for (const [label, button] of buttons) {
      button.disabled = label === 'Globe' && !summary.definition.drawing.geographic
      button.setAttribute(
        'aria-pressed',
        String(
          label === 'Auto-rotate' ? settings.get('network.orbit') !== 0 : label === projection,
        ),
      )
    }
    view.orbit = settings.get('network.orbit')
    // A pitch alone turns the camera and keeps a fit that is due.
    if (tilt !== settings.get('network.tilt')) {
      tilt = settings.get('network.tilt')
      view.camera = { pitch: tilt }
    }
    if (covered(clock.now())) view.at = clock.now()
    selection()
  }

  /** The selection where the Network draws it, else the elements nearest it there. */
  function selection() {
    const data = cases.slot.current?.data
    if (!host || !data) return
    const element = state.selection
    const entities =
      element && summary && networkRole(summary.definition, element.table)
        ? [element]
        : [...(state.anchors ?? [])]
    const key = JSON.stringify(entities)
    if (key === selected) return
    selected = key
    host.view.selection = entities.map((entity) => ({
      data: data.name,
      table: entity.table,
      ids: [entity.id],
    }))
    if (entities[0] && key !== own) host.fit({ reveal: { data: data.name, ...entities[0] } })
  }

  /** Whether every sampled binding holds the frames at `at`. */
  function covered(at: number): boolean {
    if (!summary || !state.results?.frames) return true
    return sampledFields(summary.definition, state.bindings, state.results).every((field) => {
      const range = windows.get(JSON.stringify(field))?.range
      return !!range && at >= range[0] && at <= range[1]
    })
  }

  function prefetch(at: number) {
    if (!visible() || !summary) return
    const results = state.results
    const wanted = new Set<string>()
    if (results?.frames)
      for (const [table, field] of sampledFields(summary.definition, state.bindings, results)) {
        const key = JSON.stringify([table, field])
        wanted.add(key)
        const window = windows.get(key) ?? new FrameWindow(reads)
        windows.set(key, window)
        if (
          window.pending &&
          window.requested &&
          at >= window.requested[0] &&
          at <= window.requested[1]
        )
          continue
        const range = window.range
        const domain = results.domain ?? [at, at]
        const playing = clock.state.status === 'playing'
        if (
          range &&
          at >= range[0] &&
          ((!playing && at <= range[1] && window.version === results.frames) ||
            at < range[1] - (range[1] - range[0]) / 4 ||
            (at <= range[1] && range[1] >= domain[1] && window.version === results.frames))
        )
          continue
        void window
          .playhead(
            {
              results: results.id,
              table,
              field,
              range: playing
                ? [
                    Math.max(domain[0], at - 0.25),
                    Math.min(domain[1], at + Math.max(1, clock.state.rate * 2)),
                  ]
                : [at, at],
              purpose: 'playhead',
              bytes: 8 * 1024 * 1024,
            },
            results.frames,
            at,
          )
          .then((changed) => {
            if (changed && !closed) paint()
          }, fail)
      }
    let removed = false
    for (const [key, window] of windows)
      if (!wanted.has(key)) {
        window.clear()
        windows.delete(key)
        removed = true
      }
    if (removed && host) paint()
  }

  async function backgrounds() {
    const settings = reader(state.settings)
    const mode = summary?.definition.drawing.geographic
      ? settings.get('network.map.source')
      : 'none'
    const key = JSON.stringify([
      mode,
      settings.get('network.map.tilesUrl'),
      settings.get('network.map.attribution'),
      theme().palette,
    ])
    if (mapKey === key) return
    mapKey = key
    mapController?.abort()
    const controller = (mapController = new AbortController())
    try {
      const next = await backgroundOf(
        mode,
        settings,
        new URL(asset('latkit-assets')),
        theme().palette,
        controller.signal,
      )
      if (controller.signal.aborted || closed) {
        next.destroy?.()
        return
      }
      const old = background
      background = next
      attribution.hidden = !next.attribution
      attribution.textContent = next.attribution ?? ''
      paint()
      old.destroy?.()
    } catch (error) {
      if (!controller.signal.aborted) {
        mapKey = ''
        fail(error)
      }
    }
  }

  async function render() {
    if (creating || !visible() || !cases.slot.current || !summary) return
    creating = true
    const generation = epoch
    try {
      const device = await (opening ??= openGpu().catch((error: unknown) => {
        // A device that did not open is asked for again by the next render, as Reload View's.
        opening = undefined
        throw error
      }))
      if (closed || generation !== epoch) {
        if (closed) device.destroy()
        return
      }
      gpu = device
      mark('canvas:gpu')
      let fit = false
      if (!host) {
        const saved = bridge.state<{ uri?: string; camera?: Camera }>({})
        const camera = restore ?? (saved.uri === state.uri ? saved.camera : undefined)
        const made = await ViewHost.open(
          canvas,
          scene(cases.slot.current.data, summary),
          { gpu: device, sources: sources(), ...(camera && { camera }) },
          fail,
          () => {
            mark('canvas:frame')
            fallback.hidden = true
            main.setAttribute('aria-busy', 'false')
          },
        )
        if (closed || generation !== epoch || !visible()) {
          made.destroy()
          return
        }
        host = made
        fit = !camera
        selected = ''
        restore = undefined
        stops.push(
          bindInteractions(made.view, {
            select(element) {
              own = JSON.stringify(element ? [element] : [])
              bridge.send({ kind: 'select', element })
            },
            open(element) {
              bridge.send({ kind: 'select', element })
              bridge.command('revealInSource')
            },
            menu: (point, elements) => nativeMenu(canvas, point, elements, state, 'network'),
            camera: framing,
            error: fail,
          }),
        )
      }
      paint()
      if (fit) host.fit(caseFit(cases.slot.current.data, summary.definition.drawing))
      follow()
      void backgrounds()
    } finally {
      creating = false
      if (generation !== epoch && visible() && !host) void render().catch(fail)
    }
  }

  const off = bridge.on((message) => {
    if (message.kind === 'state') {
      const previous = state
      state = merged(state, message.state)
      if (previous.uri !== state.uri) {
        drop()
        cases.clear()
        summary = undefined
        restore = undefined
      }
      if (previous.uri !== state.uri || previous.results?.id !== state.results?.id) {
        for (const window of windows.values()) window.clear()
        windows.clear()
        reads.clear()
      }
      const next = state.summary
      if (next && !state.stale) {
        const fields = sceneFields(next.definition, state.bindings)
        void cases
          .receive({ revision: revisionOf(next), fields }, fields)
          .then((changed) => {
            if (!changed || closed) return
            summary = next
            heldFields = new Map(fields.map(({ table, fields }) => [table, new Set(fields)]))
            received++
            mark('canvas:data')
            return render()
          })
          .catch(fail)
      }
      paint()
      prefetch(clock.now())
      void backgrounds()
      if (!state.summary && state.error) {
        fallback.hidden = true
        main.setAttribute('aria-busy', 'false')
      }
    } else if (message.kind === 'shown') {
      shown = message.shown
      if (visible()) void render().catch(fail)
      else drop()
    } else if (message.kind === 'action') {
      if (message.command === 'reloadView') {
        drop()
        void render().catch(fail)
      } else if (message.command === 'fit' && cases.slot.current && summary)
        host?.fit(caseFit(cases.slot.current.data, summary.definition.drawing))
      else if (message.command === 'neighborhood' && host && cases.slot.current) {
        // What the Network draws for the element in context, and what each of those links to.
        const { view } = host
        const data = cases.slot.current.data.name
        const entities = Array.isArray(message.value) ? message.value.filter(isEntity) : []
        if (entities.length)
          host.fit({
            rows: entities.flatMap((entity) => [
              { data, table: entity.table, ids: [entity.id] },
              ...view.neighbors({ data, ...entity }),
            ]),
          })
      } else if (message.command === 'exportImage' && host && summary && state.uri) {
        const [shown, uri, name] = [host, state.uri, summary.name]
        // The picture shows the view as framed, never its background before its first fit.
        void shown
          .framed()
          .then(() => saveImage(viewShot(shown.view), uri, name, 'network', page.signal))
          .catch(fail)
      }
    }
  })
  const unwatch = watchTheme(() => {
    paint()
    void backgrounds()
  })
  const visibility = () => {
    if (visible()) void render().catch(fail)
    else drop()
  }
  document.addEventListener('visibilitychange', visibility)
  const hooks = window as Window & {
    gridkitLifecycle?: () => unknown
    gridkitStats?: () => unknown
    gridkitSelection?: () => unknown
    gridkitLocate?: (entity: Entity, port?: string) => unknown
  }
  hooks.gridkitLifecycle = () => ({
    closed,
    shown,
    hidden: document.hidden,
    creating,
    epoch,
    summary: summary?.version,
    projection: cases.slot.current?.key,
    view: !!host,
    gpu: !!gpu,
  })
  hooks.gridkitStats = () => {
    if (!host || !gpu) return undefined
    const { view } = host
    return {
      ...view.stats,
      complete: view.complete,
      waiting: view.waiting,
      space: view.scene.space,
      work: gpu.work,
      resident: gpu.resident,
      uploading: gpu.uploading,
      at: view.at,
      requestedAt: clock.now(),
      covered: covered(clock.now()),
      windows: [...windows.values()].map((window) => ({
        span: window.range,
        pending: window.pending,
      })),
      received,
      bindings: drawnBindings,
      cacheBytes: reads.bytes,
      reads: reads.active,
    }
  }
  hooks.gridkitSelection = () =>
    host && {
      entities: host.view.selection.flatMap((group) =>
        group.ids.map((id) => ({ table: group.table, id })),
      ),
      camera: host.view.camera,
    }
  hooks.gridkitLocate = (entity, port) =>
    host && cases.slot.current
      ? host.view.screenOf(
          { data: cases.slot.current.data.name, ...entity },
          { ...(port && { port }), signal: host.lifetime },
        )
      : null
  window.addEventListener(
    'pagehide',
    () => {
      closed = true
      page.abort()
      drop()
      off()
      unwatch()
      clock.stop()
      resizing.disconnect()
      clearTimeout(saving)
      mapController?.abort()
      background.destroy?.()
      for (const window of windows.values()) window.clear()
      cases.clear()
      reads.clear()
      gpu?.destroy()
      document.removeEventListener('visibilitychange', visibility)
    },
    { once: true },
  )
  bridge.ready()
}
boot()
