import * as vscode from 'vscode'

import { Latest } from './async.js'
import type { Cases, CaseState } from './case.js'
import { identityColumn } from './gridkit/classes.js'

export class ElementStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'gridkitStudio.element',
    vscode.StatusBarAlignment.Right,
    100,
  )
  private readonly time = vscode.window.createStatusBarItem(
    'gridkitStudio.time',
    vscode.StatusBarAlignment.Right,
    99,
  )
  private readonly focus: vscode.Disposable
  private subscription?: vscode.Disposable
  private readonly read = new Latest()
  constructor(private readonly cases: Cases) {
    this.item.name = 'Focused Case Element'
    this.time.name = 'Simulation Time'
    this.time.command = 'gridkitStudio.seekTime'
    this.focus = cases.onDidChangeFocus((state) => this.adopt(state))
    this.adopt(cases.focused)
  }
  private adopt(state?: CaseState): void {
    this.subscription?.dispose()
    this.subscription = state?.onDidChange((kind) => {
      this.renderTime(state)
      if (kind === 'snapshot' || kind === 'selection') void this.render(state)
    })
    void this.render(state)
    this.renderTime(state)
  }
  private renderTime(state?: CaseState): void {
    if (!state?.source?.info?.rows) {
      this.time.hide()
      return
    }
    const { timeline } = state
    this.time.text = `${timeline.time.toLocaleString(undefined, { maximumFractionDigits: 4 })} s`
    this.time.tooltip = `${timeline.follow ? 'Following latest samples' : timeline.playing ? `Playing at ${timeline.speed}×` : 'Time paused'}\nGo to Time`
    this.time.show()
  }
  private async render(state?: CaseState): Promise<void> {
    const signal = this.read.next()
    const selection = state?.selection
    const target = state?.target
    this.item.hide()
    if (!state || !selection || !target || !state.current(target) || !state.fields) return
    const { element, field } = selection
    try {
      const data = await state.fields.model.load(element.classId, signal)
      if (
        signal.aborted ||
        this.cases.focused !== state ||
        state.selection !== selection ||
        !state.current(target)
      )
        return
      const cls = state.fields.model.classes.find((cls) => cls.id === element.classId)!
      const label = `${cls.label} ${data.labels[element.index]}`
      const fieldLabel =
        field && field.id !== identityColumn(element.classId)
          ? (data.columns.find((column) => column.id === field.id)?.label ?? field.id)
          : undefined
      const text = `${label}${fieldLabel ? ` · ${fieldLabel}` : ''}`.replace(/[\r\n\t]+/g, ' ')
      this.item.text = (text.length > 64 ? `${text.slice(0, 61)}…` : text).replace(/\$\(/g, '\\$(')
      this.item.tooltip = `${state.fields.model.name}\n${label} · ${element.classId}[${element.index}]${field ? `\n${field.source}: ${field.id}` : ''}\nShow in Source`
      this.item.command = {
        command: 'gridkitStudio.elementSource',
        title: 'Show in Source',
        arguments: [{ ...target, ...selection }],
      }
      this.item.accessibilityInformation = { label: `${text}. Show in Source.`, role: 'button' }
      this.item.show()
    } catch {
      /* A newer selection or document revision superseded the label read. */
    }
  }
  dispose(): void {
    this.read.abort()
    this.focus.dispose()
    this.subscription?.dispose()
    this.item.dispose()
    this.time.dispose()
  }
}
