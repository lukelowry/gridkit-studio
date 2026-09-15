import { COLORMAPS } from '@latkit/colormaps'
import { fieldKey, type FieldRef } from '@latkit/model'
import { OPTIONS, validateOptions } from '@latkit/monitor'
import type { Port } from '@latkit/port'
import { serveResults } from '@latkit/remote'
import * as vscode from 'vscode'

import { coalesce, Latest } from '../async.js'
import type { Cases, CaseState } from '../case.js'
import { caseCommand, command } from '../commands.js'
import type { CsvSource } from '../csv/source.js'
import { describe } from '../errors.js'
import { signalStatus } from '../fields.js'
import { bound, classCapabilities } from '../menus.js'
import { faultLabel } from '../simulation/faults.js'
import type { Target } from '../targets.js'
import { html, webviewPort } from '../webview/host.js'
import { paddedDomain } from './axes.js'
import { isRequest, type LaneState, type PlotPreferences, type ToMonitor } from './messages.js'

export const MONITOR = 'gridkitStudio.monitor'
export class MonitorView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private port?: Port
  private served?: { id: string; close(): void }
  private state?: CaseState
  private subscription?: vscode.Disposable
  private readonly activated: vscode.Disposable
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly cursorRead = new Latest()
  private readonly refreshRead = new Latest()
  private readonly readCursor = coalesce(() => this.cursorValues())
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cases: Cases,
    context: vscode.ExtensionContext,
  ) {
    this.activated = cases.onDidActivate((state) => this.adopt(state))
    const active = (name: string, action: (state: CaseState) => unknown) =>
      command(context, name, () => cases.active && action(cases.active))
    command(context, 'openMonitor', () => this.show(cases.active))
    command(context, 'monitorField', () => this.chooseFields())
    command(context, 'monitorWindow', () => this.chooseWindow())
    active('resetMonitorWindow', (state) => state.setDisplay({ timeRange: null }))
    caseCommand(context, cases, 'monitorOptions', (state, target) =>
      this.chooseOptions(state, target),
    )
    caseCommand(context, cases, 'retryMonitor', async (state, target) => {
      if (state !== this.state) return
      await this.refresh()
      this.post({ type: 'retry', target: state.target, field: target.field })
    })
    caseCommand(context, cases, 'removePlot', (state, target) => {
      if (target.field) this.setPlot(state, target.field, null)
    })
    active('toggleTimeline', (state) => state.timeline.toggle())
    active('pauseTimeline', (state) => state.timeline.pause())
    active('previousSample', (state) => state.timeline.step(-1))
    active('nextSample', (state) => state.timeline.step(1))
    active('unloopTime', (state) => state.timeline.setLoop(false))
    active('unfollowTime', (state) => state.timeline.followLatest(false))
    active('loopTime', (state) => state.timeline.setLoop(!state.timeline.loop))
    active('followTime', (state) => state.timeline.followLatest(!state.timeline.follow))
    active('timeSpeed', async (state) => {
      const text = await vscode.window.showInputBox({
        title: 'Animation Speed',
        value: String(state.timeline.speed),
        prompt: 'Simulation seconds per second. 1 is real time.',
        validateInput: (value) =>
          value.trim() && Number.isFinite(Number(value)) && Number(value) > 0
            ? undefined
            : 'Enter a positive speed.',
      })
      if (text !== undefined && !state.disposed) state.timeline.setSpeed(Number(text))
    })
    active('seekTime', async (state) => {
      const range = state.timeline.range
      const target = state.target
      if (!range) return
      const value = await vscode.window.showInputBox({
        title: 'Go to Time',
        prompt: `${range[0]} to ${range[1]} seconds`,
        value: String(state.timeline.time),
        validateInput: (text) =>
          text.trim() &&
          Number.isFinite(Number(text)) &&
          Number(text) >= range[0] &&
          Number(text) <= range[1]
            ? undefined
            : 'Enter a time in the available range.',
      })
      if (value !== undefined && state.current(target)) {
        state.timeline.pause()
        state.timeline.seek(Number(value))
      }
    })
    caseCommand(context, cases, 'signalRange', (state, target) => this.chooseScale(state, target))
    caseCommand(context, cases, 'signalColormap', (state) => this.chooseColormap(state))
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const port = webviewPort(view.webview)
    this.port = port
    this.subscriptions.push(
      {
        dispose: () => {
          this.served?.close()
          this.served = undefined
        },
      },
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isRequest(message)) return
        if (message.type === 'ready') {
          this.adopt(this.cases.active)
          return
        }
        if (message.type === 'focus') {
          if (this.state) this.cases.focus(this.state)
          return
        }
        const state = this.cases.resolve(message.target)
        if (state !== this.state || !state) return
        void (async () => {
          if (message.type === 'action') {
            await vscode.commands.executeCommand(
              `gridkitStudio.${message.command}`,
              message.command === 'showSolverOutput'
                ? state.run
                : message.command === 'runSolver'
                  ? state.document.uri
                  : { ...state.target, field: message.field },
            )
            return
          }
          if (message.type === 'window') {
            const available = state.timeline.range
            if (
              message.range &&
              (!available || message.range[0] < available[0] || message.range[1] > available[1])
            )
              return
            state.setDisplay({ timeRange: message.range })
            return
          }
          if (message.type === 'toggle') {
            state.timeline.toggle()
            return
          }
          if (message.type === 'step') {
            await state.timeline.step(message.direction)
            return
          }
          state.timeline.pause()
          if (message.type === 'select' && message.frame !== undefined)
            await state.timeline.seekFrame(message.frame)
          else state.timeline.seek(message.time)
          if (message.type === 'select') await this.cases.select(message.target, message.selection)
        })().catch((error) => {
          if (error?.name !== 'AbortError') void vscode.window.showErrorMessage(describe(error))
        })
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.adopt(this.cases.active)
        else {
          this.cursorRead.abort()
          this.refreshRead.abort()
        }
      }),
      view.onDidDispose(() => {
        this.cursorRead.abort()
        this.refreshRead.abort()
        this.view = undefined
        this.port = undefined
        for (const item of this.subscriptions.splice(0)) item.dispose()
      }),
    )
    view.webview.html = html(
      view.webview,
      this.extensionUri,
      'monitor',
      `<main aria-label="Monitor">
<p id="notice" role="status">Choose signals in Simulation, then run the case or open a monitor CSV.</p><div id="lanes"></div><div id="time-ruler" hidden><span id="time-caption">Time (s)</span><div id="time-axis" tabindex="0" role="slider" aria-label="Simulation time"><div id="time-ticks"></div><div class="time-cursor" aria-hidden="true"></div></div></div></main><div id="context" hidden></div>`,
    )
  }
  private adopt(state?: CaseState): void {
    this.subscription?.dispose()
    this.cursorRead.abort()
    this.state = state
    this.subscription = state?.onDidChange((kind) => {
      if (kind === 'pending' || kind === 'draft') return
      if (kind === 'time' || kind === 'selection') this.cursor()
      else if (kind !== 'setup') void this.refresh()
    })
    void this.refresh()
  }
  private post(message: ToMonitor): void {
    if (this.view?.visible) this.port?.post(message)
  }
  private setPlot(state: CaseState, field: FieldRef, plot: PlotPreferences | null): void {
    const plots = new Map(state.plots)
    if (plot) plots.set(fieldKey(field), plot)
    else plots.delete(fieldKey(field))
    state.setDisplay({ plots })
  }
  private cursor(): void {
    const state = this.state
    if (!state || !this.view?.visible) return
    this.post({
      type: 'cursor',
      target: state.target,
      time: state.timeline.time,
      selection: state.selection,
      clock: state.timeline.state,
    })
    this.readCursor()
  }
  private async cursorValues(): Promise<void> {
    const state = this.state
    const selection = state?.selection
    const source = state?.source
    const fields = state?.fields
    if (!state || !selection || !source || !fields || !this.view?.visible) return
    const { time, frame } = state.timeline
    const target = state.target
    const plotted = [...state.plots.values()]
      .map((plot) => plot.field)
      .filter((field) => field.classId === selection.element.classId && source.has(field))
    const signal = this.cursorRead.next()
    try {
      const index = frame ?? (await source.locate(time, signal))
      const values = await source.cellsAt(index, plotted, [selection.element.index], signal)
      const data = await fields.model.load(selection.element.classId, signal)
      if (
        !signal.aborted &&
        this.state === state &&
        state.current(target) &&
        state.timeline.time === time &&
        state.timeline.frame === frame &&
        state.selection === selection
      )
        this.post({
          type: 'cursor',
          target,
          time,
          selection,
          clock: state.timeline.state,
          label: data.labels[selection.element.index],
          values: Object.fromEntries(plotted.map((field, i) => [fieldKey(field), values[i]])),
        })
    } catch (error) {
      if (!signal.aborted && this.state === state)
        console.warn('Cannot read signal:', describe(error))
    }
  }
  private async lanes(state: CaseState | undefined, signal: AbortSignal): Promise<LaneState[]> {
    const fields = state?.fields
    const csv = state?.source
    if (!state || !fields) return []
    const plots = [...state.plots.values()].filter((plot) =>
      fields.signals(plot.field.classId).some((field) => field.id === plot.field.id),
    )
    return Promise.all(
      plots.map(async (plot) => {
        const { field } = plot
        const cls = fields.model.classes.find((cls) => cls.id === field.classId)!
        const info = fields.signals(field.classId).find((signal) => signal.id === field.id)!
        const status = state.signalState(field)
        const available = status.available > 0
        return {
          field,
          signalIndex: csv?.has(field)
            ? csv.signals(field.classId).findIndex((signal) => fieldKey(signal) === fieldKey(field))
            : null,
          label: `${cls.label} / ${info.label}`,
          unit: info.unit,
          recordedCount: status.available,
          status: available && status.available === status.total ? '' : signalStatus(status),
          action: available
            ? undefined
            : status.expected && status.runStatus && status.runStatus !== 'running'
              ? { command: 'showSolverOutput' as const, label: 'Show Terminal' }
              : !status.monitored
                ? { command: 'signalElements' as const, label: 'Choose Elements' }
                : status.runStatus !== 'running'
                  ? { command: 'runSolver' as const, label: 'Run Case' }
                  : undefined,
          elementCount: cls.count,
          frameCount: available ? (csv?.info?.rows ?? 0) : 0,
          range: csv?.info?.range ?? [0, 1],
          colorRange: available ? await state.signalRange(field, signal) : undefined,
          colormap: state.display.colormap,
          valueRange:
            plot.valueRange ??
            (available ? paddedDomain(await csv!.extent(field, signal)) : [0, 1]),
          appearance: plot.appearance,
          capabilities: {
            ...classCapabilities(fields.model, field.classId, true, state.bindings),
            plot: true,
            unbind: bound(state.bindings, field.classId, field),
          },
        }
      }),
    )
  }
  private notice(state: CaseState | undefined, plotCount: number): string {
    if (state?.run?.error) return state.run.error
    if (state?.run?.dataError) return `Monitor: ${state.run.dataError}`
    if (plotCount) return ''
    if (!state?.source?.info?.rows) {
      if (state?.run?.status === 'running') return 'Waiting for GridKit to produce samples...'
      return 'Choose signals in Simulation, then run the case or open a monitor CSV.'
    }
    return 'Add a plot to inspect signals.'
  }
  private serve(csv?: CsvSource): void {
    if (this.served?.id === csv?.id) return
    this.served?.close()
    this.served = csv && this.port ? { id: csv.id, close: serveResults(this.port, csv) } : undefined
  }
  private async refresh(): Promise<void> {
    const signal = this.refreshRead.next()
    const state = this.state
    const csv = state?.source
    if (!this.view?.visible) return
    this.serve(csv)
    try {
      const fields = await this.lanes(state, signal)
      if (signal.aborted || state !== this.state) return
      this.post({
        type: 'monitor',
        sourceId: csv?.id,
        timeRange: state?.display.timeRange ?? null,
        target: state?.target,
        name: state?.fields?.model.name ?? '',
        status: this.notice(state, fields.length),
        events:
          state?.run?.launch.input.events.map((event) => ({
            time: event.time,
            label: `${event.type.toLowerCase() === 'fault_on' ? 'Apply' : 'Clear'} fault · ${faultLabel(state.run!.launch.raw, event.element_id)}`,
          })) ?? [],
        fields,
        time: state?.timeline.time ?? 0,
        selection: state?.selection ?? null,
        clock: state?.timeline.state,
      })
      this.cursor()
    } catch (error) {
      if (!signal.aborted) {
        console.warn('Cannot load signals:', error)
        this.post({
          type: 'monitor',
          timeRange: null,
          fields: [],
          name: '',
          status: describe(error),
          time: 0,
          selection: null,
        })
      }
    }
  }
  async show(state?: CaseState, target?: Target): Promise<void> {
    if (state) {
      this.cases.focus(state)
      if (this.state !== state) this.adopt(state)
      if (target?.element)
        await this.cases.select(target, { element: target.element, field: target.field })
      let field = target?.field?.source === 'signal' ? target.field : undefined
      if (!field && target?.element && state.fields) {
        const choices = state.fields.signals(target.element.classId)
        field = (
          await vscode.window.showQuickPick(
            choices.map((field) => ({ label: field.label, field })),
            { title: 'Plot Signal' },
          )
        )?.field
      }
      if (field && !state.disposed && (!target || state.current(target)))
        this.setPlot(state, field, state.plots.get(fieldKey(field)) ?? { field })
    }
    await vscode.commands.executeCommand(`${MONITOR}.focus`)
    await this.refresh()
  }
  private async chooseFields(): Promise<void> {
    const state = this.state ?? this.cases.active
    const target = state?.target
    if (!state?.fields || !target) return
    const { fields } = state
    const choices = await vscode.window.showQuickPick(
      fields.model.classes
        .flatMap((cls) => fields.signals(cls.id))
        .map((field) => ({
          label: field.label,
          description: `${field.classId} / ${signalStatus(state.signalState(field))}`,
          field,
          picked: state.plots.has(fieldKey(field)),
        })),
      { title: 'Monitor Plots', canPickMany: true, matchOnDescription: true },
    )
    if (!choices || !state.current(target)) return
    const plots = new Map(
      choices.map(({ field }) => [fieldKey(field), state.plots.get(fieldKey(field)) ?? { field }]),
    )
    state.setDisplay({ plots })
  }
  private async range(
    title: string,
    current?: readonly [number, number] | null,
  ): Promise<readonly [number, number] | null | undefined> {
    const value = await vscode.window.showInputBox({
      title,
      prompt: 'Minimum, maximum. Leave empty for automatic.',
      value: current?.join(', ') ?? '',
      validateInput: (text) => {
        const values = text.split(',').map(Number)
        return !text.trim() ||
          (values.length === 2 && values.every(Number.isFinite) && values[0] < values[1])
          ? undefined
          : 'Enter two finite, increasing values.'
      },
    })
    return value === undefined
      ? undefined
      : value.trim()
        ? (value.split(',').map(Number) as [number, number])
        : null
  }
  private async chooseWindow(): Promise<void> {
    const state = this.state
    if (!state) return
    const range = await this.range('Monitor Time Window (s)', state.display.timeRange)
    if (range !== undefined && !state.disposed) state.setDisplay({ timeRange: range })
  }
  private async pickPlot(state: CaseState, field?: FieldRef): Promise<PlotPreferences | undefined> {
    if (field) return state.plots.get(fieldKey(field))
    const choice = await vscode.window.showQuickPick(
      [...state.plots.values()].map((plot) => ({
        label: `${plot.field.classId}.${plot.field.id}`,
        plot,
      })),
      { title: 'Choose Plot' },
    )
    return choice?.plot
  }
  private async chooseOptions(state: CaseState, target: Target): Promise<void> {
    const plot = await this.pickPlot(state, target.field)
    if (!plot) return
    const current = () => state.current(target) && state.plots.get(fieldKey(plot.field)) === plot
    if (!current()) return
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Automatic Range', id: 'auto' },
        { label: 'Set Range...', id: 'range' },
        { label: 'Reset Appearance', id: 'reset' },
        { label: 'Advanced Appearance...', id: 'appearance' },
        { label: 'Remove Plot', id: 'remove' },
      ],
      { title: `${plot.field.id} Plot` },
    )
    if (!choice || !current()) return
    switch (choice.id) {
      case 'auto':
        this.setPlot(state, plot.field, { ...plot, valueRange: undefined })
        return
      case 'range': {
        const range = await this.range(`${plot.field.id} Plot Axis Range`, plot.valueRange)
        if (range === undefined || !current()) return
        this.setPlot(state, plot.field, { ...plot, valueRange: range ?? undefined })
        return
      }
      case 'reset':
        this.setPlot(state, plot.field, { ...plot, appearance: undefined })
        return
      case 'remove':
        this.setPlot(state, plot.field, null)
        return
    }
    const property = await vscode.window.showQuickPick(
      [
        { label: 'Line Width', key: 'lineWidthPx' as const },
        { label: 'Other Trace Opacity', key: 'unselectedAlpha' as const },
        { label: 'Selected Trace Color', key: 'focusColor' as const },
      ],
      { title: 'Advanced Appearance' },
    )
    if (!property || !current()) return
    const key = property.key
    const text = await vscode.window.showInputBox({
      title: property.label,
      value: JSON.stringify(plot.appearance?.[key] ?? OPTIONS[key].default),
      prompt:
        key === 'focusColor'
          ? 'RGBA [red, green, blue, alpha], each 0 to 1; null for automatic.'
          : 'Nonnegative number.',
      validateInput: (text) => {
        try {
          validateOptions({ [key]: JSON.parse(text) })
          return
        } catch (error) {
          return describe(error)
        }
      },
    })
    if (text === undefined || !current()) return
    this.setPlot(state, plot.field, {
      ...plot,
      appearance: { ...plot.appearance, [key]: JSON.parse(text) },
    })
  }
  private async chooseScale(state: CaseState, target: Target): Promise<void> {
    const field = target.field ?? (await this.pickPlot(state))?.field
    if (!field) return
    const range = await this.range(
      `${field.classId}.${field.id} Color Range`,
      state.display.scales.get(fieldKey(field)),
    )
    if (range === undefined || !state.current(target)) return
    const scales = new Map(state.display.scales)
    if (range) scales.set(fieldKey(field), range)
    else scales.delete(fieldKey(field))
    state.setDisplay({ scales })
  }
  private async chooseColormap(state: CaseState): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      Object.entries(COLORMAPS).map(([value, info]) => ({ label: info.label, value })),
      { title: 'Case Colormap: Network and Monitor' },
    )
    if (choice && !state.disposed) state.setDisplay({ colormap: choice.value })
  }
  dispose(): void {
    this.served?.close()
    this.cursorRead.abort()
    this.refreshRead.abort()
    this.subscription?.dispose()
    this.activated.dispose()
    for (const item of this.subscriptions) item.dispose()
  }
}
