import './theme.css'

import type { Diagram } from '@latkit/diagram'
import {
  appendData,
  createData,
  type Data,
  type DataBatch,
  type FieldValues,
  type RowBatch,
  type SampleBatch,
} from '@latkit/model'
import type { Network } from '@latkit/network'

import type { ViewState } from '../messages.js'
import { loadBorders } from './borders.js'
import { bridge } from './bridge.js'
import { CanvasGpu } from './gpu.js'
import { accessibility, diagramStyle, networkStyle } from './style.js'
import { diagramOf, networkOf } from './topology.js'

function boot() {
  const mark = (name: string) => {
    if (!performance.getEntriesByName(name).length) performance.mark(name)
  }
  mark('canvas:boot')
  const kind = document.body.dataset.kind
  if (kind !== 'network' && kind !== 'diagram') return
  document.getElementById('app')!.innerHTML =
    '<main class="shell"><div class="warning" hidden role="status"></div><div class="surface"><canvas tabindex="0" aria-label="' +
    kind +
    ' view. Right-click an element for actions; press F2 to edit the selected field."></canvas><div class="empty" role="status">Loading case…</div></div></main>'
  const canvas = document.querySelector('canvas')!
  const empty = document.querySelector<HTMLElement>('.empty')!
  const warning = document.querySelector<HTMLElement>('.warning')!
  canvas.addEventListener('contextmenu', (event) => event.stopPropagation())
  const owner = new CanvasGpu()
  let networkModule: typeof import('./network.js') | undefined
  let diagramModule: typeof import('./diagram.js') | undefined
  let base: Data | undefined
  let data: Data | undefined
  let view: Network | Diagram | undefined
  let state: ViewState = {}
  let stream = 0
  let revision = 0
  let replaceBase = true
  let schema: Data['schema'] | undefined
  let batches: DataBatch[] = []
  let positions: Record<string, FieldValues> = {}
  let closed = false
  let rendering = false
  let queued = false
  let geographic = false
  let borders: Data | null = null
  let borderRequest: Promise<void> | undefined
  let selectionKey = ''
  let preferredProjection: string | undefined
  const error = (reason: unknown) => {
    empty.hidden = false
    empty.textContent =
      'Canvas unavailable: ' +
      String(reason) +
      '. Use the native Reload action, or inspect this case in Case, Inspector, or JSON.'
    bridge.send({ kind: 'error', message: String(reason) })
  }
  const lost = () => {
    view?.destroy()
    view = undefined
    delete canvas.dataset.connected
    delete canvas.dataset.rendered
    error('WebGPU device lost')
  }
  // Load independent renderer resources while the worker prepares the case.
  const rendererReady =
    kind === 'network'
      ? import('./network.js').then((module) => {
          networkModule = module
        })
      : import('./diagram.js').then((module) => {
          diagramModule = module
        })
  void rendererReady.catch(error)
  void owner.get(lost).catch(error)
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
        return paint()
      })
      .catch((reason) => {
        // Optional map decoration must never prevent interaction with the case.
        bridge.send({ kind: 'error', message: 'Map boundaries: ' + String(reason) })
      })
  }
  async function paint() {
    if (!view || !data) return
    const current = view
    accessibility(state)
    const patch =
      kind === 'diagram'
        ? diagramStyle(data, state, positions)
        : networkStyle(data, state, geographic, borders)
    if (!closed && view === current) {
      current.set(patch as never)
      if (canvas.dataset.rendered) decorate()
      if (kind === 'network') {
        const preference = state.settings?.['network.camera.projection'] ?? 'globe'
        const projection = preference === 'globe' && !geographic ? 'flat' : preference
        if (preferredProjection !== projection) {
          preferredProjection = projection
          ;(current as Network).set({ camera: { projection, orbit: false, fit: true } })
        }
      }
    }
  }
  function selection(force = false) {
    if (!view) return
    const key = (state.selection?.id ?? '') + ':' + (state.selection?.field ?? '')
    if (!force && key === selectionKey) return
    selectionKey = key
    try {
      if (kind === 'diagram') {
        const diagram = view as Diagram
        const item = state.selection
          ? diagramModule!.diagramItem(diagram, state.selection)
          : undefined
        diagram.select(item ? [item] : [])
        if (item && state.navigate) diagram.reveal(item)
      } else {
        const network = view as Network
        const item = state.selection
          ? networkModule!.networkItem(network, state.selection)
          : undefined
        network.select(item ? [item] : [])
        if (item && state.navigate) network.reveal(item)
      }
    } catch {
      /* A newer document projection can supersede the selection. */
    }
  }
  async function render() {
    if (!data || closed) return
    if (rendering) {
      queued = true
      return
    }
    rendering = true
    try {
      if (
        kind === 'diagram' &&
        !diagramOf(data.schema).vertices.some((type) => {
          const rows = data!.tables[type]?.rows
          return rows && (rows.kind === 'range' ? rows.count : rows.values.length) > 0
        })
      ) {
        view?.destroy()
        view = undefined
        empty.hidden = false
        empty.textContent =
          'This case has no directed signal components. Use Network to inspect its electrical topology.'
        return
      }
      const [gpu] = await Promise.all([owner.get(lost), rendererReady])
      mark('canvas:gpu')
      if (closed) return
      if (kind === 'network') {
        if (!networkModule) return
        mark('canvas:module')
        if (closed) return
        const topology = networkModule.networkTopology(data, positions)
        geographic =
          networkOf(data.schema).geographic &&
          !Object.values(topology.vertices).some((vertex) => vertex.position)
        if (!view) {
          const preference = state.settings?.['network.camera.projection'] ?? 'globe'
          preferredProjection = preference === 'globe' && !geographic ? 'flat' : preference
          view = networkModule.mountNetwork(
            gpu,
            canvas,
            data,
            {
              ...networkStyle(data, state, geographic, borders),
              camera: {
                projection: preferredProjection as 'flat' | 'globe' | 'tilt',
                orbit: false,
                fit: true,
              },
            },
            () => state,
            positions,
          )
        } else view.set({ source: data, ...topology } as never)
      } else {
        if (!diagramModule) return
        if (closed) return
        if (!view) view = diagramModule.mountDiagram(gpu, canvas, data, {}, () => state)
        else view.set({ source: data })
      }
      mark('canvas:mounted')
      if (!canvas.dataset.connected) {
        canvas.dataset.connected = 'true'
        const events = view as Network
        events.on('error', error)
        events.on('frame', () => {
          if (!canvas.dataset.rendered) mark('canvas:frame')
          canvas.dataset.rendered = 'true'
          empty.hidden = true
          decorate()
          canvas.dataset.stats = JSON.stringify(view?.stats())
        })
        events.on('camera', (camera) => bridge.save({ uri: state.uri, camera }))
        const saved = bridge.state<{ uri?: string; camera?: never }>({})
        if (saved.uri === state.uri && saved.camera) view.set({ camera: saved.camera })
        else {
          const initial = view
          const off = events.on('frame', () => {
            off()
            if (view === initial) initial.fit(undefined, { animate: false })
          })
        }
      }
      view.set({ at: state.at })
      await paint()
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
  bridge.on((message) => {
    if (message.kind === 'state') {
      const beforeSettings = state.settings
      const beforeBindings = JSON.stringify(state.bindings)
      const beforeRun = state.run?.id
      const beforeEditing = state.diagramEditing
      const beforeStale = state.stale
      state = { ...state, ...message.state }
      canvas.setAttribute(
        'aria-label',
        state.diagramEditing
          ? 'Diagram editing. Drag ports to wire and blocks to place. Right-click for actions.'
          : kind +
              ' view. Right-click an element for actions; press F2 to edit the selected field.',
      )
      warning.hidden = !state.stale || !state.summary
      warning.textContent =
        'Source is updating or contains errors. Showing the last valid revision; editing is paused.'
      view?.set({ at: state.at })
      selection()
      if (
        beforeSettings !== state.settings ||
        beforeBindings !== JSON.stringify(state.bindings) ||
        beforeRun !== state.run?.id ||
        beforeEditing !== state.diagramEditing ||
        beforeStale !== state.stale
      )
        void paint().catch(error)
    } else if (message.kind === 'begin') {
      mark('canvas:begin')
      stream = message.stream
      revision = message.revision.version
      batches = []
      schema = message.schema
      replaceBase = message.base
      if (message.positions) positions = message.positions
    } else if (message.kind === 'batch') {
      if (message.stream === stream) batches.push(...message.batches)
      bridge.send({ kind: 'ack', stream: message.stream, sequence: message.sequence })
    } else if (message.kind === 'end' && message.stream === stream && schema) {
      mark('canvas:data')
      try {
        if (replaceBase)
          base = createData(
            schema,
            batches.filter((batch): batch is RowBatch => batch.kind === 'rows'),
          )
        data = appendData(
          base!,
          batches.filter((batch): batch is SampleBatch => batch.kind === 'samples'),
        )
        batches = []
        if (revision === state.summary?.version) void render().catch(error)
      } catch (reason) {
        error(reason)
      }
    } else if (message.kind === 'action') {
      if (message.command === 'error') {
        error(message.value)
        return
      }
      if (message.command === 'reloadView') {
        view?.destroy()
        view = undefined
        delete canvas.dataset.connected
        delete canvas.dataset.rendered
        borderRequest = undefined
        void render().catch(error)
        return
      }
      if (!view) return
      if (message.command === 'fit') view.fit()
      else if (message.command === 'projection' && kind === 'network')
        (view as Network).set({
          camera: { orbit: false, projection: message.value as 'flat', fit: true },
        })
      else if (message.command === 'orbit' && kind === 'network') {
        const network = view as Network
        if (state.settings?.['accessibility.motion'] !== 'reduce')
          network.set({ camera: { orbit: !network.camera.orbit } })
      } else if (message.command === 'neighborhood') {
        if (kind === 'diagram') {
          const diagram = view as Diagram
          if (diagram.selection[0]) diagram.fit(diagram.neighborhood(diagram.selection[0]))
        } else {
          const network = view as Network
          if (network.selection[0]) network.fit(network.neighborhood(network.selection[0]))
        }
      }
    }
  })
  const observer = new MutationObserver(() => void paint().catch(error))
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  document.addEventListener('visibilitychange', () => view?.set({ paused: document.hidden }))
  window.addEventListener('pagehide', () => {
    closed = true
    observer.disconnect()
    view?.destroy()
    view = undefined
    owner.dispose()
  })
  bridge.send({ kind: 'ready' })
}
boot()
