import './theme.css'

import type { Diagram } from '@latkit/diagram'
import type { ColormapName, ColorScale } from '@latkit/gpu'
import {
  appendData,
  createData,
  type Data,
  type DataBatch,
  type RowBatch,
  type SampleBatch,
} from '@latkit/model'
import type { Network } from '@latkit/network'

import type { ViewState } from '../messages.js'
import { bridge } from './bridge.js'
import { CanvasGpu, theme } from './gpu.js'
import { diagramOf } from './topology.js'

function boot() {
  const kind = document.body.dataset.kind
  if (kind !== 'network' && kind !== 'diagram') return
  document.getElementById('app')!.innerHTML =
    `<main class="shell"><div class="toolbar"><span class="grow">${kind === 'network' ? 'Network' : 'Diagram'}</span><button data-command="fit">Fit</button><button data-command="elementSource">Source</button><button data-command="openTable">Table</button></div><div class="warning" hidden role="status"></div><div class="surface"><canvas tabindex="0" aria-label="${kind} view. Use arrow keys to navigate, plus or minus to zoom. Inspect elements in the native Inspector." data-vscode-context='{"webviewSection":"element","preventDefaultContextMenuItems":true}'></canvas><div class="empty" role="status">Loading case…</div></div><div class="status" aria-live="polite"></div></main>`
  const canvas = document.querySelector('canvas')!
  const empty = document.querySelector<HTMLDivElement>('.empty')!
  const warning = document.querySelector<HTMLDivElement>('.warning')!
  const status = document.querySelector<HTMLDivElement>('.status')!
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-command]'))
    button.onclick = () => bridge.command(button.dataset.command!)
  const style = () => theme(kind)
  const owner = new CanvasGpu()
  let networkModule: typeof import('./network.js') | undefined
  let diagramModule: typeof import('./diagram.js') | undefined
  let base: Data | undefined
  let replaceBase = true
  let view: Network | Diagram | undefined
  let data: Data | undefined
  let state: ViewState = {}
  let stream = 0
  let batches: DataBatch[] = []
  let schema: Data['schema'] | undefined
  let closed = false
  const error = (reason: unknown) => {
    empty.hidden = false
    empty.textContent = `Canvas unavailable: ${String(reason)}. Table, Inspector, JSON, and simulations remain available.`
    bridge.send({ kind: 'error', message: String(reason) })
  }
  async function render() {
    if (!data || closed) return
    if (kind === 'diagram') {
      const vertices = diagramOf(data.schema).vertices
      if (
        !vertices.some((type) => {
          const rows = data!.tables[type]?.rows
          return rows && (rows.kind === 'range' ? rows.count : rows.values.length) > 0
        })
      ) {
        view?.destroy()
        view = undefined
        empty.hidden = false
        empty.textContent =
          'This case has no directed signal connections. Open Network to inspect its electrical topology.'
        return
      }
    }
    const gpu = await owner.get(() => {
      view?.destroy()
      view = undefined
      error('WebGPU device was lost. Reopen this view to retry.')
    })
    if (closed || !data) return
    if (!view) {
      if (kind === 'diagram') {
        diagramModule ??= await import('./diagram.js')
        if (closed) return
        view = diagramModule.mountDiagram(gpu, canvas, data, style())
      } else {
        networkModule ??= await import('./network.js')
        if (closed) return
        view = networkModule.mountNetwork(gpu, canvas, data, style())
      }
      const events = view as Network
      events.on('error', error)
      events.on('frame', () => {
        canvas.dataset.rendered = 'true'
        canvas.dataset.stats = JSON.stringify(view?.stats())
        if (view)
          status.textContent = `${state.selection?.id ?? 'Select an element to inspect'}${state.run ? ' · ' + state.run.state : ''}`
      })
      events.on('camera', (camera) => bridge.save({ camera }))
      const saved = bridge.state<{ camera?: never }>({})
      if (saved.camera) view.set({ camera: saved.camera })
    } else view.set({ source: data, at: state.at })
    empty.hidden = true
    if (kind === 'network')
      (view as Network).set({ edgeBaseColor: state.branchColors ? null : theme().textColor })
    selection()
    bindings()
  }
  let range: ColorScale['domain']
  let colormap: ColormapName = 'viridis'
  function bindings() {
    if (!view) return
    for (const [type, field] of Object.entries(state.bindings ?? {})) {
      if (view.config.vertices[type])
        view.set({ vertices: { [type]: { color: { field, domain: range, colormap } } } })
      else if (view.config.edges?.[type]) view.set({ edges: { [type]: { color: field } } })
    }
  }
  function selection() {
    if (!view || !state.selection) return
    try {
      if (kind === 'diagram') {
        const diagram = view as Diagram
        const item = diagramModule!.diagramItem(diagram, state.selection)
        diagram.select(item ? [item] : [])
        if (item && state.navigate) diagram.reveal(item)
      } else {
        const network = view as Network
        const item = networkModule!.networkItem(network, state.selection)
        network.select(item ? [item] : [])
        if (item && state.navigate) network.reveal(item)
      }
    } catch {
      /* Selection may refer to a newer revision still in transit. */
    }
  }
  bridge.on((message) => {
    if (message.kind === 'state') {
      state = { ...state, ...message.state }
      warning.hidden = !state.stale
      warning.textContent = 'Source has errors or is updating. Showing the last valid revision.'
      view?.set({ at: state.at })
      selection()
      bindings()
    } else if (message.kind === 'begin') {
      stream = message.stream
      batches = []
      schema = message.schema
      replaceBase = message.base
    } else if (message.kind === 'batch') {
      if (message.stream === stream) batches.push(...message.batches)
      bridge.send({ kind: 'ack', stream: message.stream, sequence: message.sequence })
    } else if (message.kind === 'end' && message.stream === stream && schema) {
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
        void render().catch(error)
      } catch (reason) {
        error(reason)
      }
    } else if (message.kind === 'action' && view) {
      if (message.command === 'bindingRange' && typeof message.value === 'string') {
        const bounds = message.value.split(/[, ]+/).map(Number)
        if (bounds.length === 2 && bounds.every(Number.isFinite) && bounds[0]! < bounds[1]!) {
          range = [bounds[0]!, bounds[1]!]
          bindings()
        }
      } else if (message.command === 'signalColormap') {
        colormap = message.value as ColormapName
        bindings()
      } else if (message.command === 'fit') view.fit()
      else if (message.command === 'error') error(message.value)
      else if (message.command === 'projection' && kind === 'network')
        (view as Network).set({ camera: { projection: message.value as 'flat' } })
      else if (message.command === 'orbit' && kind === 'network') {
        const network = view as Network
        network.set({ camera: { orbit: !network.camera.orbit } })
      } else if (message.command === 'neighborhood') {
        if (kind === 'diagram') {
          const diagram = view as Diagram
          const item = diagram.selection[0]
          if (item) diagram.fit(diagram.neighborhood(item))
        } else {
          const network = view as Network
          const item = network.selection[0]
          if (item) network.fit(network.neighborhood(item))
        }
      } else if (message.command === 'bind') {
        const value = message.value as { type: string; field: string }
        if (view.config.vertices[value.type])
          view.set({ vertices: { [value.type]: { color: value.field } } })
        else view.set({ edges: { [value.type]: { color: value.field } } })
      } else if (message.command === 'unbind') {
        view.set({
          vertices: Object.fromEntries(
            Object.keys(view.config.vertices).map((type) => [type, { color: null }]),
          ),
          edges: Object.fromEntries(
            Object.keys(view.config.edges ?? {}).map((type) => [type, { color: null }]),
          ),
        })
      }
    }
  })
  const observer = new MutationObserver(() => view?.set(style()))
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  document.addEventListener('visibilitychange', () => {
    if (!closed) view?.set({ paused: document.hidden })
  })
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
