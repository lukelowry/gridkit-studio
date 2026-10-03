import './theme.css'
import './monitor.css'

import {
  appendData,
  createData,
  type Data,
  type DataBatch,
  itemId,
  rowAt,
  type RowBatch,
  type SampleBatch,
  selectRows,
} from '@latkit/model'
import { createMonitor, type Monitor } from '@latkit/monitor'

import type { ViewState } from '../messages.js'
import { bridge } from './bridge.js'
import { CanvasGpu, theme } from './gpu.js'

document.getElementById('app')!.innerHTML =
  `<main class="shell"><div class="toolbar"><span class="grow">Monitor</span><button data-command="previousSample" aria-label="Previous sample">Previous</button><button data-command="toggleTimeline">Play</button><button data-command="nextSample" aria-label="Next sample">Next</button><button data-command="followTime">Follow live</button><button data-command="exportCsv">Export CSV</button></div><div class="warning" hidden role="status"></div><div class="plots"></div><div class="status" aria-live="polite"></div></main>`
const root = document.querySelector<HTMLDivElement>('.plots')!
const warning = document.querySelector<HTMLDivElement>('.warning')!
const status = document.querySelector<HTMLDivElement>('.status')!
for (const button of document.querySelectorAll<HTMLButtonElement>('button'))
  button.onclick = () =>
    bridge.command(
      button.dataset.command === 'followTime' && state.follow
        ? 'unfollowTime'
        : button.dataset.command!,
    )
const owner = new CanvasGpu()
const plots = new Map<string, { monitor: Monitor; section: HTMLElement }>()
let viewWindow: readonly [number, number] | undefined
let base: Data | undefined
let replaceBase = true
let state: ViewState = {}
let source: Data | undefined
let schema: Data['schema'] | undefined
let stream = 0
let batches: DataBatch[] = []
let closed = false
function clearPlots() {
  for (const plot of plots.values()) plot.monitor.destroy()
  plots.clear()
}
function error(reason: unknown) {
  status.textContent = 'Monitor: ' + String(reason)
  bridge.send({ kind: 'error', message: String(reason) })
}
async function render() {
  if (!source || closed) return
  const wanted = state.plots ?? []
  if (!wanted.length) {
    clearPlots()
    root.textContent = 'Choose a signal in the native Signals tree to add a plot.'
    return
  }
  if (!state.run) {
    clearPlots()
    root.textContent = 'Run a simulation or import results to plot recorded signals.'
    return
  }
  const gpu = await owner.get(() => {
    for (const plot of plots.values()) plot.monitor.destroy()
    plots.clear()
    error('WebGPU device lost. Reopen Monitor to retry.')
  })
  if (closed) return
  if (!plots.size) root.replaceChildren()
  for (const [key, plot] of plots)
    if (!wanted.some((item) => key === JSON.stringify(item))) {
      plot.monitor.destroy()
      plot.section.remove()
      plots.delete(key)
    }
  for (const plot of wanted) {
    const key = JSON.stringify(plot)
    const current = plots.get(key)
    if (current) {
      current.monitor.set({
        source,
        at: state.at,
        ...(state.follow && state.run!.domain[1] > state.run!.domain[0]
          ? { camera: { window: viewWindow ?? state.run!.domain } }
          : {}),
      })
      continue
    }
    const section = document.createElement('section')
    const title = document.createElement('h2')
    const canvas = document.createElement('canvas')
    title.textContent = plot.from + '.' + plot.field + (plot.id ? ' · ' + plot.id : '')
    canvas.tabIndex = 0
    canvas.setAttribute(
      'aria-label',
      title.textContent + ' plot. Use arrow keys to pan and plus or minus to zoom.',
    )
    section.append(title, canvas)
    root.append(section)
    const domain = viewWindow ?? state.run.domain
    const monitor = createMonitor(gpu, {
      canvas,
      source,
      traces: {
        signal: {
          from: plot.from,
          field: plot.field,
          ...(plot.id ? { rows: { kind: 'ids', ids: [plot.id] } } : {}),
        },
      },
      camera: { window: domain[1] > domain[0] ? domain : [domain[0], domain[0] + 1] },
      at: state.at,
      coordinateAxis: 'Time [s]',
      valueAxis: source.schema.types[plot.from]?.fields[plot.field]?.unit ?? plot.field,
      ...theme(),
    })
    monitor.on('error', error)
    monitor.on('frame', () => {
      canvas.dataset.rendered = 'true'
      canvas.dataset.stats = JSON.stringify(monitor.stats())
    })
    monitor.on('select', (items) => {
      const item = items[0]
      if (item) bridge.send({ kind: 'select', element: { id: itemId(item), field: plot.field } })
    })
    let down = [0, 0]
    for (const event of ['wheel', 'keydown', 'pointerdown'])
      canvas.addEventListener(event, () => bridge.command('unfollowTime'), { passive: true })
    canvas.addEventListener('pointerdown', (event) => {
      down = [event.clientX, event.clientY]
    })
    canvas.addEventListener('pointerup', (event) => {
      if (Math.hypot(event.clientX - down[0]!, event.clientY - down[1]!) > 3) return
      const bounds = canvas.getBoundingClientRect()
      void monitor
        .pick([event.clientX - bounds.left, event.clientY - bounds.top])
        .then((items) => {
          if (items[0]) bridge.command('seekTime', items[0].coordinate)
        })
        .catch(error)
    })
    monitor.on('open', () => bridge.command('elementSource'))
    let windowTimer: ReturnType<typeof setTimeout>
    monitor.on('camera', (camera) => {
      clearTimeout(windowTimer)
      windowTimer = setTimeout(() => {
        if (!closed && !state.follow) bridge.send({ kind: 'window', bounds: camera.window })
      }, 120)
    })
    plots.set(key, { monitor, section })
  }
}
bridge.on((message) => {
  if (message.kind === 'state') {
    state = { ...state, ...message.state }
    const play = document.querySelector<HTMLButtonElement>('[data-command=toggleTimeline]')!
    const follow = document.querySelector<HTMLButtonElement>('[data-command=followTime]')!
    play.textContent = state.playing ? 'Pause' : 'Play'
    play.setAttribute('aria-pressed', String(!!state.playing))
    follow.textContent = state.follow ? 'Following live' : 'Follow live'
    follow.setAttribute('aria-pressed', String(!!state.follow))
    for (const button of document.querySelectorAll<HTMLButtonElement>('.toolbar button'))
      button.disabled = !state.run?.frames
    warning.hidden =
      !state.stale && (!state.run || state.run.fingerprint === state.summary?.fingerprint)
    warning.textContent = state.stale
      ? 'Source is invalid or updating. The run retains its captured revision.'
      : 'This run belongs to an earlier case revision. Revert the case or run again to overlay results.'
    status.textContent = state.run
      ? `${state.run.state} · ${state.run.frames} frames · ${state.at?.toPrecision(6) ?? '0'} s`
      : 'No results'
    for (const plot of plots.values()) {
      plot.monitor.set({ at: state.at })
      const id = state.selection?.id
      const source = plot.monitor.config.source
      const type = id?.split('/')[0]
      const table = type ? source.tables[type] : undefined
      try {
        plot.monitor.select(
          id && table
            ? [
                {
                  source,
                  index: table.index,
                  row: rowAt(selectRows(table, { kind: 'ids', ids: [id] }), 0),
                },
              ]
            : [],
        )
      } catch {
        plot.monitor.select([])
      }
    }
  } else if (message.kind === 'begin') {
    stream = message.stream
    schema = message.schema
    replaceBase = message.base
    viewWindow = message.window
    batches = []
  } else if (message.kind === 'batch') {
    if (message.stream === stream) batches.push(...message.batches)
    bridge.send({ kind: 'ack', stream: message.stream, sequence: message.sequence })
  } else if (message.kind === 'end' && stream === message.stream && schema) {
    try {
      if (replaceBase)
        base = createData(
          schema,
          batches.filter((batch): batch is RowBatch => batch.kind === 'rows'),
        )
      source = appendData(
        base!,
        batches.filter((batch): batch is SampleBatch => batch.kind === 'samples'),
      )
      batches = []
      void render().catch(error)
    } catch (reason) {
      error(reason)
    }
  } else if (message.kind === 'action') {
    if (['fit', 'resetMonitorWindow'].includes(message.command))
      for (const plot of plots.values())
        plot.monitor.set({ camera: { window: state.run?.domain ?? [0, 1], fit: true } })
    if (message.command === 'monitorWindow' && typeof message.value === 'string') {
      const values = message.value.split(/[, ]+/).map(Number)
      if (values.length === 2 && values.every(Number.isFinite) && values[0]! < values[1]!)
        for (const plot of plots.values())
          plot.monitor.set({ camera: { window: [values[0]!, values[1]!] } })
    }
    if (message.command === 'signalRange' && typeof message.value === 'string') {
      const bounds = message.value.split(/[, ]+/).map(Number)
      if (bounds.length === 2 && bounds.every(Number.isFinite) && bounds[0]! < bounds[1]!)
        for (const plot of plots.values())
          plot.monitor.set({ camera: { values: [bounds[0]!, bounds[1]!] } })
    }
    if (message.command === 'retryMonitor') {
      for (const plot of plots.values()) plot.monitor.destroy()
      plots.clear()
      void render().catch(error)
    }
    if (message.command === 'error') error(message.value)
  }
})
const observer = new MutationObserver(() => {
  for (const plot of plots.values()) plot.monitor.set(theme())
})
observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
document.addEventListener('visibilitychange', () => {
  for (const plot of plots.values()) plot.monitor.set({ paused: document.hidden })
})
window.addEventListener('pagehide', () => {
  closed = true
  observer.disconnect()
  for (const plot of plots.values()) plot.monitor.destroy()
  plots.clear()
  owner.dispose()
})
bridge.send({ kind: 'ready' })
