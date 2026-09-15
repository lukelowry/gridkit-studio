import { colormap } from '@latkit/colormaps'
import { type Domain, fieldKey, position, type Results } from '@latkit/model'
import { createMonitor, type Reading } from '@latkit/monitor'

import { describe } from '../../errors.js'
import { menuContext } from '../../menus.js'
import { createAxis } from '../axes.js'
import type { LaneState, MonitorState, Request } from '../messages.js'
import { paintAxis } from './axis-view.js'

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const node = document.createElement(tag)
  node.className = className
  return node
}

export interface PlotHost {
  state(): MonitorState
  send(message: Request): void
  axisChanged(): void
}

export class Plot {
  readonly root = element('section', 'lane')
  private readonly title = element('h2', 'plot-title')
  private readonly annotation = element('span', 'axis-annotation')
  private readonly reading = element('span', 'reading')
  private readonly axis = element('div', 'value-axis')
  private readonly chart = element('div', 'chart')
  private readonly canvas = element('canvas', 'trace')
  private readonly cursor = element('div', 'cursor')
  private readonly error = element('p', 'error')
  private readonly status = element('span', 'plot-status')
  private readonly action = element('button', 'signal-action')
  private readonly monitor = createMonitor()
  private readonly resize: ResizeObserver
  private hovered: Reading | null = null
  private readonly read = new AbortController()
  private loading = false
  private loaded = false
  private shown = false
  private attaching = false
  private disposed = false
  private styleKey = ''
  private value?: number
  private label?: string
  private selected?: number

  constructor(
    public data: LaneState,
    private readonly results: Results | null,
    private readonly host: PlotHost,
  ) {
    this.root.dataset.key = fieldKey(data.field)
    this.root.dataset.field = data.field.id
    const header = element('header', 'lane-header')
    header.append(this.title, this.annotation, this.status, this.action, this.reading)
    this.action.addEventListener('click', () => {
      const target = this.host.state().target
      if (target && this.data.action)
        this.host.send({
          type: 'action',
          target,
          field: this.data.field,
          command: this.data.action.command,
        })
    })
    this.cursor.setAttribute('aria-hidden', 'true')
    this.error.hidden = true
    this.error.setAttribute('role', 'status')
    this.canvas.tabIndex = 0
    this.canvas.setAttribute('role', 'slider')
    this.canvas.setAttribute(
      'aria-label',
      `${data.label}. Arrow keys move time; Space plays or pauses.`,
    )
    this.chart.append(this.canvas, this.cursor, this.error)
    this.root.append(header, this.axis, this.chart)
    this.monitor.on('error', (error) => this.fail(error.message))
    this.monitor.on('deviceLost', (event) => {
      if (!event.recovering) this.fail(event.message)
    })
    this.monitor.on('rendered', () => {
      this.canvas.dataset.samples = String(this.data.frameCount)
      this.canvas.setAttribute('aria-busy', 'false')
      this.error.hidden = true
      document.body.dataset.state = 'ready'
    })
    this.monitor.on('select', (reading) => {
      const target = this.host.state().target
      if (!target) return
      this.host.send({
        type: 'select',
        target,
        selection: {
          element: { classId: this.data.field.classId, index: reading.element },
          field: this.data.field,
        },
        time: reading.t,
        frame: reading.frame,
      })
    })
    this.monitor.on('hover', (reading) => {
      this.hovered = reading
      this.renderReading()
    })
    this.canvas.addEventListener('contextmenu', () => {
      this.canvas.dataset.vscodeContext = JSON.stringify(this.context(this.hovered))
    })
    this.canvas.addEventListener('keydown', (event) => this.keydown(event))
    this.resize = new ResizeObserver(() => this.drawAxis())
    this.resize.observe(this.chart)
    this.update(data)
  }

  private async load() {
    if (!this.results || this.data.signalIndex === null || this.loaded || this.loading) return
    this.loading = true
    try {
      const series = await this.results.series(this.data.field.classId, this.read.signal)
      if (this.disposed) return
      this.monitor.load(series, this.data.signalIndex)
      this.loaded = true
      if (this.shown) await this.visible(true)
    } catch (error) {
      if (!this.read.signal.aborted && !this.disposed) this.fail(describe(error))
    } finally {
      this.loading = false
    }
  }

  private get timeRange(): Domain {
    return this.host.state().timeRange ?? this.data.range
  }

  private context(reading?: Reading | null) {
    const selection = this.host.state().selection
    const element = reading
      ? { classId: this.data.field.classId, index: reading.element }
      : selection?.element.classId === this.data.field.classId
        ? selection.element
        : undefined
    return menuContext(
      { ...this.host.state().target!, field: this.data.field, ...(element && { element }) },
      this.data.capabilities,
      'monitor',
    )
  }

  private keydown(event: KeyboardEvent) {
    const [min, max] = this.timeRange
    const target = this.host.state().target
    if (!target) return
    switch (event.key) {
      case ' ':
        this.host.send({ type: 'toggle', target })
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        this.host.send({ type: 'step', target, direction: -1 })
        break
      case 'ArrowRight':
      case 'ArrowUp':
        this.host.send({ type: 'step', target, direction: 1 })
        break
      case 'Home':
        this.host.send({ type: 'seek', target, time: min })
        break
      case 'End':
        this.host.send({ type: 'seek', target, time: max })
        break
      case 'ContextMenu':
        this.openContext()
        break
      case 'F10':
        if (event.shiftKey) this.openContext()
        else return
        break
      default:
        return
    }
    event.preventDefault()
  }

  private openContext() {
    const context = document.getElementById('context')!
    const rect = this.canvas.getBoundingClientRect()
    context.dataset.vscodeContext = JSON.stringify(this.context())
    context.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: rect.left + 40,
        clientY: rect.top + 30,
      }),
    )
  }

  private drawAxis() {
    const axis = createAxis(this.data.valueRange, this.chart.clientHeight, true)
    paintAxis(this.axis, axis, true)
    this.annotation.textContent = axis.annotation
    this.annotation.title = axis.annotation
    this.host.axisChanged()
  }

  get axisWidth(): number {
    return (
      Math.max(
        24,
        ...Array.from(this.axis.children, (label) => label.getBoundingClientRect().width),
      ) + 12
    )
  }

  update(data: LaneState) {
    this.action.textContent = data.action?.label ?? ''
    this.action.hidden = !data.action
    this.status.title = data.status
    this.status.textContent = data.status
    this.status.hidden = !data.status
    this.axis.hidden = !data.frameCount
    this.canvas.hidden = !data.frameCount
    this.data = data
    void this.load()
    this.title.textContent = `${data.label}${data.unit ? ` · ${data.unit}` : ''}`
    this.title.title = `${data.label}: ${data.recordedCount.toLocaleString()} of ${data.elementCount.toLocaleString()} elements have samples`
    this.root.dataset.vscodeContext = JSON.stringify(this.context())
    const key = JSON.stringify([
      this.timeRange,
      data.valueRange,
      data.colorRange,
      data.colormap,
      data.appearance,
    ])
    if (key !== this.styleKey) {
      this.styleKey = key
      const palette = colormap((data.colormap ?? 'viridis') as Parameters<typeof colormap>[0])
      const domain = data.valueRange
      this.monitor.setOptions({
        lineWidthPx: 1.25,
        focusColor: null,
        unselectedAlpha: 0.4,
        ...data.appearance,
        timeRange: this.timeRange,
        valueRange: domain,
        colorRange: data.colorRange ?? null,
        colormap: palette,
      })
    }
    this.drawAxis()
    this.updateCursor()
    if (this.shown && this.loaded) void this.visible(true)
  }

  updateCursor(value?: number, label?: string) {
    const state = this.host.state()
    const selected =
      state.selection?.element.classId === this.data.field.classId
        ? state.selection.element.index
        : undefined
    if (selected !== this.selected) {
      this.value = undefined
      this.label = undefined
    }
    this.selected = selected
    this.value = value
    this.label = label
    this.monitor.select(selected ?? null)
    this.animateCursor(state.time)
    const range = state.clock?.range ?? this.data.range
    this.canvas.setAttribute('aria-valuemin', String(range[0]))
    this.canvas.setAttribute('aria-valuemax', String(range[1]))
    this.canvas.setAttribute('aria-valuenow', String(state.time))
    this.canvas.setAttribute('aria-valuetext', `${state.time} seconds`)
    this.canvas.dataset.vscodeContext = JSON.stringify(this.context())
    this.renderReading()
  }

  private renderReading() {
    const reading = this.hovered
    const value = reading?.value ?? this.value
    const index = reading?.element ?? this.selected
    const label = reading ? `${this.data.field.classId}[${index}]` : this.label
    this.reading.textContent =
      value === undefined
        ? ''
        : `${label ?? index}: ${value.toLocaleString(undefined, { maximumSignificantDigits: 8 })}`
    this.reading.title =
      value === undefined
        ? ''
        : `${label ?? index}: ${value}${this.data.unit ? ` ${this.data.unit}` : ''} at ${reading?.t ?? this.host.state().time} s`
  }

  animateCursor(time: number) {
    const fraction = position(time, this.timeRange)
    this.cursor.hidden = !this.data.frameCount || fraction < 0 || fraction > 1
    this.cursor.style.left = `${Math.max(0, Math.min(1, fraction)) * 100}%`
  }

  private fail(message: string) {
    this.error.textContent = `${message} Use Retry Monitor from the view menu.`
    this.error.hidden = false
    this.canvas.setAttribute('aria-busy', 'false')
  }

  async visible(shown: boolean) {
    this.shown = shown
    if (!shown) {
      this.monitor.detach()
      return
    }
    if (!this.loaded || this.monitor.attached || this.attaching || this.disposed) return
    this.attaching = true
    this.canvas.setAttribute('aria-busy', 'true')
    let cancelled = false
    try {
      await this.monitor.attach(this.canvas)
      if (!this.shown || this.disposed) this.monitor.detach()
    } catch (error) {
      cancelled = error instanceof Error && error.name === 'AbortError'
      if (!cancelled && this.shown && !this.disposed) this.fail(describe(error))
    } finally {
      this.attaching = false
      if (cancelled && this.shown && !this.disposed) void this.visible(true)
    }
  }

  dispose() {
    this.disposed = true
    this.read.abort()
    this.resize.disconnect()
    this.monitor.destroy()
    this.root.remove()
  }
}
