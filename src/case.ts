import { randomUUID } from 'node:crypto'

import { type Domain, type ElementRef, fieldKey, type FieldRef } from '@latkit/model'
import type { Edit } from 'jsonc-parser'
import * as vscode from 'vscode'

import { Latest } from './async.js'
import {
  type Binding,
  type Bindings,
  type DisplayChannel,
  extent,
  validateBinding,
} from './bindings.js'
import { report } from './commands.js'
import type { CsvSource } from './csv/source.js'
import { Documents, isCase, type Snapshot } from './documents.js'
import { CaseFields, type SignalState } from './fields.js'
import type { Case } from './gridkit/validate.js'
import type { PlotPreferences } from './monitor/messages.js'
import type { Run } from './run.js'
import { type MonitoringChange, monitoringEdits } from './signals/edits.js'
import type { SimulationSetup } from './simulation/setup.js'
import type { CaseTarget, Selection, Target } from './targets.js'
import { Timeline } from './timeline.js'

export type Change =
  | 'pending'
  | 'monitoring'
  | 'draft'
  | 'snapshot'
  | 'selection'
  | 'bindings'
  | 'results'
  | 'time'
  | 'setup'
  | 'display'

export interface Display {
  /** Null selects the first available signal once. An empty map keeps all plots closed. */
  readonly plots: ReadonlyMap<string, PlotPreferences> | null
  readonly scales: ReadonlyMap<string, Domain>
  readonly timeRange: Domain | null
  readonly colormap: string
}

export type ReadyCase = CaseState & { readonly fields: CaseFields; readonly raw: Case }

export class CaseState implements vscode.Disposable {
  private readonly session = randomUUID()
  private readonly changed = new vscode.EventEmitter<Change>()
  readonly onDidChange = this.changed.event
  private readonly reads = new Latest()
  private readonly selectionRead = new Latest()
  private readonly writes = new Map<DisplayChannel, number>()
  private inputIdentity?: string
  private monitoringWrite: Promise<void> = Promise.resolve()
  disposed = false
  simulationDraft?: import('./simulation/setup.js').SimulationDraft
  get editing(): boolean {
    return this.simulationDraft !== undefined
  }
  setDraft(draft: typeof this.simulationDraft): void {
    const changed = !!draft !== !!this.simulationDraft
    this.simulationDraft = draft
    if (changed) this.changed.fire('draft')
  }
  get inputKey(): string | undefined {
    return this.inputIdentity
  }
  get owner(): string {
    return this.session
  }

  snapshot: Snapshot
  fields?: CaseFields
  selection: Selection | null = null
  bindings: Bindings = {}
  display: Display = { plots: null, scales: new Map(), timeRange: null, colormap: 'viridis' }
  setup: SimulationSetup = {
    kind: 'memory',
    options: { tmax: 10, dt_monitor: 1 / 240, events: [] },
  }
  run?: Run
  source?: CsvSource
  readonly timeline = new Timeline(
    () => {
      this.fields?.setTime(this.timeline.time, this.timeline.frame)
      this.changed.fire('time')
    },
    () => this.source,
  )

  constructor(
    readonly document: vscode.TextDocument,
    snapshot: Snapshot,
  ) {
    this.snapshot = snapshot
    if (snapshot.state === 'valid') {
      this.inputIdentity = snapshot.case.inputIdentity
      this.fields = new CaseFields(snapshot.case.model, () => this.source)
    }
  }

  assertCommitted(): void {
    if (this.editing)
      throw new Error('Apply or cancel the unfinished Simulation edit before continuing.')
  }

  get signal(): AbortSignal {
    return this.reads.signal
  }
  get raw(): Case | undefined {
    return this.snapshot.state === 'valid' ? this.snapshot.case.raw : undefined
  }
  get target(): CaseTarget {
    return {
      uri: this.document.uri.toString(),
      version: this.snapshot.version,
      revision: `${this.session}:${this.snapshot.version}`,
    }
  }
  get plots(): ReadonlyMap<string, PlotPreferences> {
    return this.display.plots ?? new Map()
  }
  signalState(field: FieldRef, element?: number): SignalState {
    const key = fieldKey(field)
    const members =
      this.snapshot.state === 'valid' ? this.snapshot.case.monitoring.get(key) : undefined
    const expected = this.run?.monitoring.get(key)
    const count = (values?: ReadonlySet<number>) =>
      element === undefined ? (values?.size ?? 0) : Number(values?.has(element) ?? false)
    return {
      total:
        element === undefined
          ? (this.fields?.model.classes.find((cls) => cls.id === field.classId)?.count ?? 0)
          : Number(this.has({ classId: field.classId, index: element })),
      monitored: count(members),
      available: this.source?.info?.rows ? this.source.recordedCount(field, element) : 0,
      expected: count(expected),
      runStatus: this.run?.status,
    }
  }
  /** Edits in gesture order; only monitoring-only revisions may be rebased. */
  updateMonitoring(
    cases: Cases,
    inputKey: string,
    changes: readonly MonitoringChange[],
  ): Promise<void> {
    const apply = async () => {
      if (this.inputKey !== inputKey || !this.current(this.target))
        throw new Error('The case changed. Review the signals before applying this edit.')
      await cases.edit([
        {
          document: this.document,
          version: this.document.version,
          edits: monitoringEdits(this.document.getText(), changes),
        },
      ])
    }
    const pending = this.monitoringWrite.then(apply)
    this.monitoringWrite = pending.catch(() => {})
    return pending
  }

  current(target: CaseTarget): boolean {
    return (
      !this.disposed &&
      !this.document.isClosed &&
      this.document.version === target.version &&
      target.uri === this.target.uri &&
      target.revision === this.target.revision &&
      this.snapshot.state === 'valid'
    )
  }
  has(ref: ElementRef): boolean {
    const count = this.fields?.model.classes.find((cls) => cls.id === ref.classId)?.count ?? 0
    return Number.isSafeInteger(ref.index) && ref.index >= 0 && ref.index < count
  }

  update(snapshot: Snapshot): void {
    if (this.snapshot === snapshot) return
    this.reads.next()
    this.selectionRead.abort()
    this.writes.clear()
    this.snapshot = snapshot
    if (snapshot.state === 'pending') {
      this.changed.fire('pending')
      return
    }
    const parsed = snapshot.state === 'valid' ? snapshot.case : undefined
    const compatible = !!parsed && this.inputIdentity === parsed.inputIdentity
    const hadFields = this.fields !== undefined
    this.fields = parsed && new CaseFields(parsed.model, () => this.source)
    if (!compatible) this.selection = null
    if (parsed) {
      if (!compatible) void this.attachRun(undefined).catch(report)
      else if (this.run) this.run.target = this.target
      this.inputIdentity = parsed.inputIdentity
      this.fields!.setTime(this.timeline.time, this.timeline.frame)
    }
    this.changed.fire(compatible && hadFields ? 'monitoring' : 'snapshot')
    if (parsed) void this.reconcile()
  }
  private async reconcile(): Promise<void> {
    const target = this.target
    const fields = this.fields!
    const signal = this.reads.signal
    for (const [channel, binding] of Object.entries(this.bindings) as [DisplayChannel, Binding][]) {
      try {
        validateBinding(fields.model, channel, binding)
        if (signal.aborted) return
        await fields.field(binding.field, signal)
      } catch {
        if (this.current(target) && this.bindings[channel] === binding) {
          const next = { ...this.bindings }
          delete next[channel]
          this.bindings = next
          this.changed.fire('bindings')
        }
      }
    }
  }

  async select(target: CaseTarget, next: Selection | null): Promise<boolean> {
    if (
      !this.current(target) ||
      (next &&
        (!this.has(next.element) || (next.field && next.field.classId !== next.element.classId)))
    )
      return false
    const signal = this.selectionRead.next()
    if (next?.field) {
      try {
        await this.fields!.field(next.field, signal)
      } catch {
        return false
      }
    }
    if (!this.current(target) || signal.aborted) return false
    const previous = this.selection
    if (
      previous?.element.classId === next?.element.classId &&
      previous?.element.index === next?.element.index &&
      (previous?.field ? fieldKey(previous.field) : '') ===
        (next?.field ? fieldKey(next.field) : '')
    )
      return true
    this.selection = next
      ? { element: { ...next.element }, ...(next.field && { field: { ...next.field } }) }
      : null
    this.changed.fire('selection')
    return true
  }
  async bind(target: CaseTarget, channel: DisplayChannel, binding: Binding | null): Promise<void> {
    if (!this.current(target) || !this.fields) return
    const serial = (this.writes.get(channel) ?? 0) + 1
    this.writes.set(channel, serial)
    if (binding) {
      validateBinding(this.fields.model, channel, binding)
      try {
        await this.fields.field(binding.field, this.reads.signal)
      } catch (error) {
        if (!this.current(target)) return
        throw error
      }
    }
    if (!this.current(target) || this.writes.get(channel) !== serial) return
    const next = { ...this.bindings }
    if (binding)
      next[channel] = {
        field: { ...binding.field },
        ...(binding.range && { range: [...binding.range] as [number, number] }),
      }
    else delete next[channel]
    this.bindings = next
    this.changed.fire('bindings')
  }
  setDisplay(patch: Partial<Display>): void {
    this.display = { ...this.display, ...patch }
    this.changed.fire('display')
  }
  setSetup(setup: SimulationSetup): void {
    this.setup = setup
    this.changed.fire('setup')
  }
  async signalRange(field: FieldRef, signal?: AbortSignal): Promise<Domain> {
    const fixed = this.display.scales.get(fieldKey(field))
    if (fixed) return fixed
    return field.source === 'signal'
      ? ((await this.source?.extent(field, signal)) ?? [0, 1])
      : extent((await this.fields!.column(field, signal)).values)
  }

  async attachSource(source?: CsvSource): Promise<void> {
    const previous = this.source
    this.source = source
    this.timeline.pause()
    this.timeline.update(source?.info?.range ?? null)
    this.resultsChanged()
    if (previous !== source) await previous?.dispose()
  }
  async attachRun(run: Run | undefined): Promise<void> {
    const previous = this.run
    this.run = run
    const cleared = this.attachSource(undefined)
    await previous?.dispose()
    await cleared
  }
  resultsChanged(): void {
    if (this.display.plots === null && this.source?.info?.rows) {
      const first = this.fields?.model.classes.flatMap((cls) => this.fields!.recorded(cls.id))[0]
      if (first)
        this.display = { ...this.display, plots: new Map([[fieldKey(first), { field: first }]]) }
    }
    this.changed.fire('results')
  }

  private disposal?: Promise<void>
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.selectionRead.abort()
    this.reads.abort()
    this.timeline.dispose()
    this.changed.dispose()
    return (this.disposal = (async () => {
      try {
        await this.run?.dispose()
      } finally {
        await this.source?.dispose()
      }
    })())
  }
}

export interface DocumentEdits {
  document: vscode.TextDocument
  version: number
  edits: readonly Edit[]
}

export class Cases implements vscode.Disposable {
  private readonly states = new Map<string, CaseState>()
  private readonly activated = new vscode.EventEmitter<CaseState | undefined>()
  private readonly focusChanged = new vscode.EventEmitter<CaseState | undefined>()
  private readonly subscriptions: vscode.Disposable[]
  /** The case the sidebars show: the last one focused or run. */
  readonly onDidActivate = this.activated.event
  active?: CaseState
  /** The case whose editor or view has keyboard focus, if any. */
  readonly onDidChangeFocus = this.focusChanged.event
  focused?: CaseState

  constructor(readonly documents: Documents) {
    this.subscriptions = [
      documents.onDidChange(({ document, snapshot }) => {
        const state = this.states.get(document.uri.toString())
        if (state?.document === document) state.update(snapshot)
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const state = this.states.get(document.uri.toString())
        if (!state || state.document !== document) return
        void state.dispose().catch(report)
        this.states.delete(document.uri.toString())
        if (this.active === state) {
          this.active = undefined
          this.activated.fire(undefined)
        }
        if (this.focused === state) this.focus(undefined)
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.focus(isCase(editor.document.uri) ? this.get(editor.document) : undefined)
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
        if (input instanceof vscode.TabInputText && isCase(input.uri)) return
        if (input instanceof vscode.TabInputCustom && input.viewType === 'gridkitStudio.network')
          return
        this.focus(undefined)
      }),
    ]
  }
  owned(owner: string): CaseState | undefined {
    return [...this.states.values()].find((state) => state.owner === owner && !state.disposed)
  }
  get(document: vscode.TextDocument): CaseState {
    const key = document.uri.toString()
    let state = this.states.get(key)
    if (!state) {
      state = new CaseState(document, this.documents.current(document))
      this.states.set(key, state)
    }
    return state
  }
  activate(state: CaseState): void {
    if (state.disposed || this.active === state) return
    this.active = state
    this.activated.fire(state)
  }
  focus(state: CaseState | undefined): void {
    if (state?.disposed) return
    if (state) this.activate(state)
    if (this.focused === state) return
    this.focused = state
    this.focusChanged.fire(state)
  }
  resolve(target: Target): ReadyCase | undefined {
    const state = this.states.get(target.uri)
    return state?.current(target) && (!target.element || state.has(target.element))
      ? (state as ReadyCase)
      : undefined
  }
  async select(target: CaseTarget, selection: Selection | null): Promise<void> {
    await this.resolve(target)?.select(target, selection)
  }
  /** Applies edits, then reparses immediately so the next target already reflects them. */
  async edit(changes: readonly DocumentEdits[]): Promise<void> {
    if (changes.some(({ document, version }) => document.isClosed || document.version !== version))
      throw new Error('The document changed. Review the current values before applying the edit.')
    const edit = new vscode.WorkspaceEdit()
    let count = 0
    for (const { document, edits } of changes)
      for (const change of edits) {
        count++
        edit.replace(
          document.uri,
          new vscode.Range(
            document.positionAt(change.offset),
            document.positionAt(change.offset + change.length),
          ),
          change.content,
        )
      }
    if (!count) return
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The edit could not be applied.')
    for (const { document, edits } of changes)
      if (edits.length && isCase(document.uri) && !document.isClosed)
        await this.documents.ensureParsed(document)
  }
  private disposal?: Promise<void>
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    const pending = [...this.states.values()].map((state) => state.dispose())
    this.states.clear()
    this.activated.dispose()
    this.focusChanged.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
    return (this.disposal = Promise.all(pending).then(() => {}))
  }
}
