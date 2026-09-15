import './style.css'

import { type Domain, fieldKey } from '@latkit/model'
import type { MonitorSource, SourceBlock } from '@latkit/monitor'
import { connect } from '@latkit/port'

import { port, vscode } from '../../webview/client.js'
import { createAxis, position } from '../axes.js'
import type { LaneState, MonitorState, Request, ToMonitor } from '../messages.js'
import { sourceProtocol } from '../source.js'
import { paintAxis } from './axis-view.js'
import { Plot } from './plot.js'

const container = document.querySelector<HTMLElement>('#lanes')!
const notice = document.querySelector<HTMLElement>('#notice')!
const ruler = document.querySelector<HTMLElement>('#time-ruler')!
const timeAxis = document.querySelector<HTMLElement>('#time-axis')!
const ticks = document.querySelector<HTMLElement>('#time-ticks')!
const caption = document.querySelector<HTMLElement>('#time-caption')!
const cursor = document.querySelector<HTMLElement>('.time-cursor')!
const connection = connect(port, sourceProtocol)
const plots = new Map<string, Plot>()
let state: MonitorState
let receivedAt = 0
let animation = 0
let axisFrame = 0
let scrubFrame = 0
let pendingSeek: number | undefined
let scrubPointer: number | undefined
const send = (message: Request) => vscode.postMessage(message)

const visibility = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      void plots.get((entry.target as HTMLElement).dataset.key!)?.visible(entry.isIntersecting)
    }
  },
  { root: container },
)

function timeRange(): Domain {
  return state.timeRange ?? state.clock?.range ?? state.fields[0]?.range ?? [0, 1]
}

function updateAxes() {
  if (!state) return
  cancelAnimationFrame(axisFrame)
  axisFrame = requestAnimationFrame(() => {
    const width = Math.ceil(Math.max(36, ...Array.from(plots.values(), (plot) => plot.axisWidth)))
    document.documentElement.style.setProperty('--axis-width', `${width}px`)
    // Match the plot column even when the scrolling list has a scrollbar.
    ruler.style.paddingRight = `${container.offsetWidth - container.clientWidth + 12}px`
    const range = timeRange()
    const axis = createAxis(range, timeAxis.clientWidth)
    timeAxis.title = `${range[0]} to ${range[1]} seconds. Drag to seek. Ctrl+wheel to zoom, Shift+wheel to pan, double-click to reset.`
    paintAxis(ticks, axis)
    caption.textContent = `s${axis.annotation ? ` ${axis.annotation}` : ''}`
    caption.title = caption.textContent
    for (const previous of timeAxis.querySelectorAll('.event-marker')) previous.remove()
    for (const event of state.events ?? []) {
      const fraction = position(event.time, range)
      if (fraction < 0 || fraction > 1) continue
      const marker = document.createElement('span')
      marker.className = 'event-marker'
      marker.style.left = `${fraction * 100}%`
      marker.title = `${event.label} · ${event.time} s`
      marker.setAttribute('aria-hidden', 'true')
      timeAxis.append(marker)
    }
  })
}

function addPlot(data: LaneState) {
  const sourceId = state.sourceId
  let plot: Plot
  const source: MonitorSource = {
    elementCount: data.elementCount,
    get frameCount() {
      return plot?.data.frameCount ?? data.frameCount
    },
    get timeRange() {
      return plot?.data.range ?? data.range
    },
    valueRange: null,
    locate: async (time, signal) =>
      (await connection.call(
        { sourceId: sourceId!, field: data.field, type: 'locate', time },
        { signal },
      )) as number,
    read: async (window, signal) =>
      (await connection.call(
        { sourceId: sourceId!, field: data.field, type: 'read', window },
        { signal },
      )) as SourceBlock,
  }
  plot = new Plot(data, source, { state: () => state, send, axisChanged: updateAxes })
  plots.set(fieldKey(data.field), plot)
  container.append(plot.root)
  visibility.observe(plot.root)
}

function removePlot(key: string) {
  const plot = plots.get(key)
  if (!plot) return
  visibility.unobserve(plot.root)
  plot.dispose()
  plots.delete(key)
}

function drawCursor(time: number) {
  for (const plot of plots.values()) plot.animateCursor(time)
  const fraction = position(time, timeRange())
  cursor.hidden = fraction < 0 || fraction > 1
  cursor.style.left = `${Math.max(0, Math.min(1, fraction)) * 100}%`
}

function animate() {
  animation = 0
  const clock = state.clock
  if (!clock?.playing || !clock.range) return
  const [start, end] = clock.range
  let time = clock.time + ((performance.now() - receivedAt) / 1000) * clock.speed
  time = clock.loop && end > start ? start + ((time - start) % (end - start)) : Math.min(end, time)
  drawCursor(time)
  animation = requestAnimationFrame(animate)
}

function updateClock() {
  receivedAt = performance.now()
  const range = state.clock?.range ?? timeRange()
  timeAxis.setAttribute('aria-valuemin', String(range[0]))
  timeAxis.setAttribute('aria-valuemax', String(range[1]))
  timeAxis.setAttribute('aria-valuenow', String(state.time))
  timeAxis.setAttribute('aria-valuetext', `${state.time} seconds`)
  drawCursor(state.time)
  if (state.clock?.playing && !animation) animation = requestAnimationFrame(animate)
  if (!state.clock?.playing) {
    cancelAnimationFrame(animation)
    animation = 0
  }
}

port.subscribe((value) => {
  const message = value as ToMonitor
  if (message.type === 'monitor') {
    if (state?.target?.uri !== message.target?.uri || state?.sourceId !== message.sourceId) {
      cancelScrub()
      for (const key of plots.keys()) removePlot(key)
    }
    state = message
    document.body.dataset.case = state.target?.uri ?? ''
    document.body.dataset.field = state.fields[0]?.field.id ?? ''
    notice.textContent = state.status
    notice.hidden = !state.status
    ruler.hidden = !state.fields.some((field) => field.frameCount > 0)
    document.body.dataset.state = state.fields.length
      ? plots.size
        ? (document.body.dataset.state ?? 'loading')
        : 'loading'
      : 'empty'
    const keys = new Set(state.fields.map((data) => fieldKey(data.field)))
    for (const key of plots.keys()) if (!keys.has(key)) removePlot(key)
    for (const data of state.fields) {
      const plot = plots.get(fieldKey(data.field))
      if (plot) plot.update(data)
      else addPlot(data)
    }
    updateAxes()
    updateClock()
  } else if (message.type === 'cursor' && state?.target?.revision === message.target.revision) {
    state = { ...state, time: message.time, selection: message.selection, clock: message.clock }
    for (const [key, plot] of plots) plot.updateCursor(message.values?.[key], message.label)
    updateClock()
  } else if (message.type === 'retry' && state?.target?.revision === message.target.revision) {
    for (const data of state.fields) {
      const key = fieldKey(data.field)
      if (message.field && fieldKey(message.field) !== key) continue
      removePlot(key)
      addPlot(data)
    }
  }
})

/** A drag belongs to the source that was open when it began. */
function cancelScrub() {
  cancelAnimationFrame(scrubFrame)
  scrubFrame = 0
  pendingSeek = undefined
  if (scrubPointer !== undefined && timeAxis.hasPointerCapture(scrubPointer)) {
    timeAxis.releasePointerCapture(scrubPointer)
  }
  scrubPointer = undefined
}

function flushSeek() {
  scrubFrame = 0
  if (pendingSeek !== undefined && state.target)
    send({ type: 'seek', target: state.target, time: pendingSeek })
  pendingSeek = undefined
}

function scrub(event: PointerEvent) {
  const rect = timeAxis.getBoundingClientRect()
  const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const [min, max] = timeRange()
  pendingSeek = min * (1 - fraction) + max * fraction
  drawCursor(pendingSeek)
  if (!scrubFrame) scrubFrame = requestAnimationFrame(flushSeek)
}

timeAxis.addEventListener('dblclick', () => {
  if (state.target) send({ type: 'window', target: state.target, range: null })
})
timeAxis.addEventListener(
  'wheel',
  (event) => {
    if (!state.target || !state.clock?.range || (!event.ctrlKey && !event.shiftKey)) return
    event.preventDefault()
    const available = state.clock.range
    const current = timeRange()
    const span = current[1] - current[0]
    const full = available[1] - available[0]
    if (!(span > 0 && full > 0)) return
    const rect = timeAxis.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const nextSpan = event.ctrlKey
      ? Math.min(
          full,
          Math.max(full * 1e-9, span * Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.005)))),
        )
      : span
    let start = event.ctrlKey
      ? current[0] + fraction * (span - nextSpan)
      : current[0] + ((event.deltaX || event.deltaY) * span) / rect.width
    start = Math.max(available[0], Math.min(available[1] - nextSpan, start))
    send({ type: 'window', target: state.target, range: [start, start + nextSpan] })
  },
  { passive: false },
)
timeAxis.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  timeAxis.focus()
  scrubPointer = event.pointerId
  timeAxis.setPointerCapture(event.pointerId)
  scrub(event)
})
timeAxis.addEventListener('pointermove', (event) => {
  if (timeAxis.hasPointerCapture(event.pointerId)) scrub(event)
})
timeAxis.addEventListener('pointerup', (event) => {
  if (!timeAxis.hasPointerCapture(event.pointerId)) return
  scrub(event)
  cancelAnimationFrame(scrubFrame)
  flushSeek()
  cancelScrub()
})
timeAxis.addEventListener('pointercancel', cancelScrub)
timeAxis.addEventListener('lostpointercapture', cancelScrub)
timeAxis.addEventListener('keydown', (event) => {
  const target = state.target
  if (!target) return
  const [min, max] = timeRange()
  if (event.key === ' ') send({ type: 'toggle', target })
  else if (event.key === 'Home' || event.key === 'End')
    send({ type: 'seek', target, time: event.key === 'Home' ? min : max })
  else if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(event.key))
    send({
      type: 'step',
      target,
      direction: ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1,
    })
  else return
  event.preventDefault()
})
const resize = new ResizeObserver(updateAxes)
resize.observe(container)
const focus = () => send({ type: 'focus' })
window.addEventListener('focus', focus)
document.addEventListener('focusin', focus)
window.addEventListener('pagehide', () => {
  cancelAnimationFrame(animation)
  cancelAnimationFrame(axisFrame)
  cancelScrub()
  resize.disconnect()
  visibility.disconnect()
  for (const plot of plots.values()) plot.dispose()
  connection.close()
})
send({ type: 'ready' })
