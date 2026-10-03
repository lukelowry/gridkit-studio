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

import type { Plot, ViewState } from '../messages.js'
import { reader } from '../preferences.js'
import { bridge } from './bridge.js'
import { nativeMenu } from './context.js'
import { CanvasGpu } from './gpu.js'
import { axisLabel, coordinateAt, PLOT_LIMITS, plotOptions, tracesOf } from './monitor-options.js'
import { font, palette } from './palette.js'
import { accessibility } from './style.js'

document.getElementById('app')!.innerHTML =
  '<main class="shell"><div class="warning" hidden role="status"></div><div class="plots"><p class="empty">Choose a field in Signals to plot recorded values.</p></div><div class="timeline"><label for="playhead">Time</label><input id="playhead" type="range" min="0" max="1" step="any" value="0" aria-label="Simulation playhead"><output for="playhead" class="clock">No results</output></div><div class="status" role="status"></div></main>'
const root = document.querySelector<HTMLElement>('.plots')!
const warning = document.querySelector<HTMLElement>('.warning')!
const status = document.querySelector<HTMLElement>('.status')!
const slider = document.querySelector<HTMLInputElement>('#playhead')!
const clock = document.querySelector<HTMLOutputElement>('.clock')!
const owner = new CanvasGpu()
const plots = new Map<
  string,
  { monitor: Monitor; section: HTMLElement; plot: Plot; dispose(): void }
>()
let viewWindow: readonly [number, number] | undefined
let base: Data | undefined
let source: Data | undefined
let schema: Data['schema'] | undefined
let state: ViewState = {}
let stream = 0
let replaceBase = true
let batches: DataBatch[] = []
let closed = false
let rendering = false
let queued = false
let seekFrame = 0
let seekValue: number | undefined
slider.addEventListener('input', () => {
  seekValue = Number(slider.value)
  if (!seekFrame)
    seekFrame = requestAnimationFrame(() => {
      seekFrame = 0
      bridge.command('seekTime', seekValue)
    })
})
function clearPlots() {
  for (const plot of plots.values()) plot.dispose()
  plots.clear()
}
function error(reason: unknown) {
  status.textContent = String(reason)
  bridge.send({ kind: 'error', message: String(reason) })
}
function style(monitor: Monitor, plot: Plot) {
  const s = reader(state.settings)
  monitor.set({
    ...plotOptions(
      s,
      palette(),
      font(),
      axisLabel(source?.schema.axis),
      plot.field +
        (source?.schema.types[plot.from]?.fields[plot.field]?.unit
          ? ' [' + source.schema.types[plot.from]!.fields[plot.field]!.unit + ']'
          : ''),
    ),
    traces: {
      plotted: {
        ...tracesOf(s, { type: plot.from, field: plot.field }).plotted,
        ...(plot.id ? { rows: { kind: 'ids', ids: [plot.id] } } : {}),
      },
    },
    camera: { fit: s.get('monitor.camera.fit') },
  })
}
function selection() {
  for (const { monitor } of plots.values()) {
    const id = state.selection?.id
    const type = id?.split('/')[0]
    const data = monitor.config.source
    const table = type ? data.tables[type] : undefined
    try {
      const selected = id && table ? selectRows(table, { kind: 'ids', ids: [id] }) : undefined
      const count = selected
        ? selected.kind === 'range'
          ? selected.count
          : selected.values.length
        : 0
      monitor.select(
        count && table ? [{ source: data, index: table.index, row: rowAt(selected!, 0) }] : [],
      )
    } catch {
      monitor.select([])
    }
  }
}
async function render() {
  if (!source || closed) return
  if (rendering) {
    queued = true
    return
  }
  rendering = true
  try {
    const wanted = state.plots ?? []
    if (!wanted.length || !state.run) {
      clearPlots()
      root.innerHTML =
        '<p class="empty">' +
        (!wanted.length
          ? 'Choose a field in the native Signals tree to add a plot.'
          : 'Run a simulation or import results to plot recorded signals.') +
        '</p>'
      return
    }
    const gpu = await owner.get(() => {
      clearPlots()
      error('WebGPU device lost. Use Reload Monitor to retry.')
    })
    if (closed) return
    root.querySelector('.empty')?.remove()
    for (const [key, plot] of plots)
      if (!wanted.some((item) => JSON.stringify(item) === key)) {
        plot.dispose()
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
          ...(state.follow && viewWindow ? { camera: { window: viewWindow } } : {}),
        })
        continue
      }
      const section = document.createElement('section')
      const heading = document.createElement('h2')
      const canvas = document.createElement('canvas')
      heading.textContent = plot.from + ' · ' + plot.field + (plot.id ? ' · ' + plot.id : '')
      canvas.tabIndex = 0
      canvas.setAttribute(
        'aria-label',
        heading.textContent + '. Click to seek; right-click for plot actions.',
      )
      canvas.addEventListener('contextmenu', (event) => event.stopPropagation())
      section.append(heading, canvas)
      root.append(section)
      const domain = viewWindow ?? state.run.domain
      const monitor = createMonitor(gpu, {
        canvas,
        source,
        traces: {
          plotted: {
            from: plot.from,
            field: plot.field,
            ...(plot.id ? { rows: { kind: 'ids', ids: [plot.id] } } : {}),
          },
        },
        limits: PLOT_LIMITS,
        camera: { window: domain[1] > domain[0] ? domain : [domain[0], domain[0] + 1] },
        at: state.at,
      })
      style(monitor, plot)
      monitor.on('error', error)
      monitor.on('frame', () => {
        canvas.dataset.rendered = 'true'
        canvas.dataset.stats = JSON.stringify(monitor.stats())
      })
      monitor.on('select', (items) => {
        if (items[0])
          bridge.send({ kind: 'select', element: { id: itemId(items[0]), field: plot.field } })
      })
      monitor.on('contextmenu', (event) =>
        nativeMenu(
          canvas,
          event.point,
          event.items.map((item) => ({ id: itemId(item), field: plot.field })),
          state,
          'monitor',
          plot,
        ),
      )
      monitor.on('open', () => bridge.command('elementSource'))
      let down: readonly [number, number] = [0, 0]
      let windowTimer: ReturnType<typeof setTimeout> | undefined
      canvas.addEventListener('wheel', () => bridge.command('unfollowTime'), { passive: true })
      canvas.addEventListener('pointerdown', (event) => {
        down = [event.clientX, event.clientY]
      })
      canvas.addEventListener('pointerup', (event) => {
        if (event.button !== 0 || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 3)
          return
        const rect = canvas.getBoundingClientRect()
        const at = coordinateAt(
          [event.clientX - rect.left, event.clientY - rect.top],
          rect.width,
          rect.height,
          monitor.camera.window,
          monitor.config,
        )
        if (at !== null) bridge.command('seekTime', at)
      })
      monitor.on('camera', (camera) => {
        clearTimeout(windowTimer)
        windowTimer = setTimeout(() => {
          if (!closed && !state.follow) bridge.send({ kind: 'window', bounds: camera.window })
        }, 120)
      })
      plots.set(key, {
        monitor,
        section,
        plot,
        dispose() {
          clearTimeout(windowTimer)
          monitor.destroy()
        },
      })
    }
    selection()
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
    const previousSettings = state.settings
    const previousSelection = JSON.stringify(state.selection)
    const previousPlots = JSON.stringify(state.plots)
    state = { ...state, ...message.state }
    accessibility(state)
    warning.hidden =
      !state.stale && (!state.run || state.run.fingerprint === state.summary?.fingerprint)
    warning.textContent = state.stale
      ? 'Source is updating or invalid. Results retain the captured case revision.'
      : 'These results belong to an earlier case revision.'
    const run = state.run
    const at = state.at ?? run?.domain[0] ?? 0
    slider.disabled = !run || run.frames < 2
    slider.min = String(run?.domain[0] ?? 0)
    slider.max = String(run?.domain[1] ?? 1)
    slider.value = String(at)
    clock.textContent = run ? at.toFixed(3) + ' / ' + run.domain[1].toFixed(3) + ' s' : 'No results'
    status.textContent = run
      ? run.name +
        ' · ' +
        run.state +
        ' · ' +
        run.frames.toLocaleString() +
        ' frames' +
        (state.follow ? ' · Following live' : '')
      : (state.summary?.name ?? 'No case')
    for (const { monitor, plot } of plots.values()) {
      monitor.set({ at: state.at })
      if (state.settings !== previousSettings) style(monitor, plot)
    }
    if (JSON.stringify(state.selection) !== previousSelection) selection()
    if (JSON.stringify(state.plots) !== previousPlots) void render().catch(error)
  } else if (message.kind === 'begin') {
    stream = message.stream
    schema = message.schema
    replaceBase = message.base
    viewWindow = message.window
    batches = []
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
    if (message.command === 'resetMonitorWindow')
      for (const { monitor } of plots.values())
        monitor.set({ camera: { window: state.run?.domain ?? [0, 1], fit: true } })
    if (message.command === 'monitorWindow' && typeof message.value === 'string') {
      const values = message.value.split(/[, ]+/).map(Number)
      if (values.length === 2 && values.every(Number.isFinite) && values[0]! < values[1]!)
        for (const { monitor } of plots.values())
          monitor.set({
            camera: {
              window: [values[0]!, values[1]!],
            },
          })
    }
    if (message.command === 'signalRange') {
      const value = message.value as { plot?: Plot; range?: [number, number] }
      const selected = value.plot ? plots.get(JSON.stringify(value.plot)) : undefined
      if (
        selected &&
        value.range?.length === 2 &&
        value.range.every(Number.isFinite) &&
        value.range[0] < value.range[1]
      )
        selected.monitor.set({ camera: { values: value.range, fit: false } })
    }
    if (message.command === 'retryMonitor') {
      clearPlots()
      root.replaceChildren()
      void render().catch(error)
    }
    if (message.command === 'error') error(message.value)
  }
})
const observer = new MutationObserver(() => {
  for (const { monitor, plot } of plots.values()) style(monitor, plot)
})
observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
document.addEventListener('visibilitychange', () => {
  for (const { monitor } of plots.values()) monitor.set({ paused: document.hidden })
})
window.addEventListener('pagehide', () => {
  closed = true
  cancelAnimationFrame(seekFrame)
  observer.disconnect()
  clearPlots()
  owner.dispose()
})
bridge.send({ kind: 'ready' })
