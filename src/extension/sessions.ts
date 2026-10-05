import type { FieldSelection } from '@latkit/model'
import * as vscode from 'vscode'

import {
  type Bindings,
  bound,
  type Channel,
  channelsFor,
  type FieldRef,
} from '../shared/bindings.js'
import type {
  Cameras,
  Element,
  Plot,
  RunInfo,
  Summary,
  TableState,
  ViewState,
} from '../shared/messages.js'
import {
  defaults,
  definitions,
  type SettingsValues,
  validateSettings,
} from '../shared/preferences.js'
import { networkOf, placementOf } from '../shared/schema.js'
import { Transport } from '../shared/transport.js'
import { Client } from './client.js'
import { Documents, isWritable } from './documents.js'

export interface Session {
  uri: string
  diagramEditing: boolean
  bindings: Bindings
  /** The field the Mappings editor is open for. */
  editing?: FieldRef
  selection?: Element
  run?: RunInfo
  previous?: RunInfo
  plots: Plot[]
  /** Undefined until the first parsed case supplies defaults; an empty array records nothing. */
  outputs?: FieldSelection[]
  values: Record<string, unknown>
  /** The case's playhead; views extrapolate it between changes. */
  transport: Transport
  settings: SettingsValues
  /** The Monitor's chosen time window; absent, plots show the whole run. */
  window?: readonly [number, number]
  cameras: Cameras
  table: TableState
}
/** Per-case workspace state; `recording` persists `Session.outputs`. */
type Saved = Partial<Pick<Session, 'bindings' | 'values' | 'plots' | 'table'>> & {
  recording?: FieldSelection[]
}

/** The display settings for `uri`; an invalid value keeps its default. */
function settingsFor(uri: vscode.Uri): SettingsValues {
  const configuration = vscode.workspace.getConfiguration('gridkitStudio', uri)
  const result = { ...defaults }
  for (const { id } of definitions) {
    const value = configuration.get(id)
    if (value === undefined) continue
    try {
      Object.assign(result, validateSettings({ [id]: value }))
    } catch {
      // The user may be mid-edit.
    }
  }
  return result
}

/** What runs record until the user chooses: each bus's voltage magnitude and angle. */
export function defaultOutputs({ schema, counts }: Summary): FieldSelection[] {
  return networkOf(schema).vertices.flatMap((type) => {
    const fields = schema.types[type]!.fields
    const select = ['Vm', 'Va'].filter((field) => fields[field]?.sampled === true)
    return counts[type] && select.length ? [{ from: type, select }] : []
  })
}

/** The plots `run` can draw: those it recorded, else its first recorded signal. */
export function plotsFor(run: RunInfo, plots: readonly Plot[]): Plot[] {
  const kept = plots.filter((plot) =>
    run.outputs.some(({ from, select }) => from === plot.from && select.includes(plot.field)),
  )
  const first = run.outputs.find(({ select }) => select.length > 0)
  return kept.length || !first ? kept : [{ from: first.from, field: first.select[0]! }]
}

export class Sessions {
  readonly client: Client
  readonly documents: Documents
  readonly all = new Map<string, Session>()
  readonly changed = new vscode.EventEmitter<string>()
  /** Fires when a case's clock changes or its following playhead moves with the head. */
  readonly clock = new vscode.EventEmitter<string>()
  readonly action = new vscode.EventEmitter<{
    uri: string
    command: string
    value?: unknown
    view?: string
  }>()
  readonly output = vscode.window.createOutputChannel('GridKit Studio', { log: true })
  readonly disposables: vscode.Disposable[] = []
  readonly contexts = new Map<string, unknown>()
  active?: string
  constructor(readonly context: vscode.ExtensionContext) {
    this.client = new Client(context)
    this.documents = new Documents(this.client)
    this.disposables.push(
      this.changed.event(() => this.updateContexts()),
      this.client.failure.event((error) => {
        for (const session of this.all.values()) {
          if (session.run?.state === 'running') {
            session.run.state = 'failed'
            session.run.message = error.message
          }
          session.transport.pause()
          session.transport.setLive(false)
          this.changed.fire(session.uri)
        }
      }),
      this.documents.changed.event((uri) => {
        if (!this.documents.entries.has(uri)) {
          this.all.get(uri)?.transport.dispose()
          this.all.delete(uri)
          if (this.active === uri) this.active = this.all.keys().next().value
        }
        this.changed.fire(uri)
      }),
      this.client.event.event((event) => {
        if (event.kind === 'log') {
          this.output.appendLine(event.message)
          return
        }
        const session = this.all.get(event.info.revision.uri)
        if (!session) return
        this.show(session, event.info)
        this.changed.fire(session.uri)
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        for (const session of this.all.values())
          if (event.affectsConfiguration('gridkitStudio', vscode.Uri.parse(session.uri))) {
            session.settings = settingsFor(vscode.Uri.parse(session.uri))
            this.changed.fire(session.uri)
          }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && /\.case\.json$/i.test(editor.document.fileName))
          void this.open(editor.document).catch((error) => this.output.error(String(error)))
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
        if (input instanceof vscode.TabInputCustom && /\.case\.json$/i.test(input.uri.path))
          this.activate(input.uri.toString())
      }),
    )
  }
  updateContexts() {
    const session = this.active ? this.all.get(this.active) : undefined
    const entry = this.active ? this.documents.entries.get(this.active) : undefined
    const values = {
      hasCase: !!session,
      diagramEditing: !!session?.diagramEditing,
      ready: !!entry?.summary && !entry.stale,
      editable: !!entry && !entry.stale && isWritable(entry.document),
      running: session?.run?.state === 'running',
      hasSamples: (session?.run?.frames ?? 0) > 0,
      hasSelection: !!session?.selection,
      tableFiltered: !!session?.table.filter,
      tableReady: !!entry?.summary,
    }
    for (const [key, value] of Object.entries(values))
      if (this.contexts.get(key) !== value) {
        this.contexts.set(key, value)
        void vscode.commands.executeCommand('setContext', 'gridkitStudio.' + key, value)
      }
  }
  activate(uri: string) {
    this.active = uri
    if (!this.all.has(uri)) {
      const saved = this.context.workspaceState.get<Saved>('case:' + uri, {})
      this.all.set(uri, {
        uri,
        bindings: saved.bindings ?? {},
        plots: saved.plots ?? [],
        outputs: saved.recording,
        values: saved.values ?? {},
        transport: new Transport(() => this.clock.fire(uri)),
        diagramEditing: false,
        settings: settingsFor(vscode.Uri.parse(uri)),
        cameras: {},
        table: saved.table ?? {},
      })
    }
    this.changed.fire(uri)
    return this.all.get(uri)!
  }
  async open(document: vscode.TextDocument) {
    const session = this.activate(document.uri.toString())
    const summary = await this.documents.ensure(document)
    if (session.outputs === undefined) {
      session.outputs = defaultOutputs(summary)
      this.changed.fire(session.uri)
    }
    return session
  }
  current() {
    const session = this.active ? this.all.get(this.active) : undefined
    if (!session) throw new Error('Open a GridKit case first.')
    return session
  }
  persist(session: Session) {
    const saved: Saved = {
      bindings: session.bindings,
      values: session.values,
      plots: session.plots,
      table: session.table,
      recording: session.outputs,
    }
    return this.context.workspaceState.update('case:' + session.uri, saved)
  }
  state(uri: string): ViewState {
    const entry = this.documents.entries.get(uri)
    const session = this.all.get(uri)
    return {
      uri,
      version: entry?.document.version,
      writable: !!entry && isWritable(entry.document),
      navigate: vscode.workspace
        .getConfiguration('gridkitStudio', vscode.Uri.parse(uri))
        .get('navigateOnSelection', false),
      diagramEditing: session?.diagramEditing,
      settings: session?.settings,
      bindings: session?.bindings,
      editing: session?.editing,
      summary: entry?.summary,
      stale: entry?.stale,
      error: entry?.error,
      selection: session?.selection,
      run: session?.run,
      outputs: session?.outputs,
      plots: session?.plots,
      window: session?.window,
      values: session?.values,
      table: session?.table,
    }
  }
  select(uri: string, element?: Element) {
    const session = this.all.get(uri) ?? this.activate(uri)
    if (session.selection?.id === element?.id && session.selection?.field === element?.field) return
    session.selection = element
    this.changed.fire(uri)
  }
  /** Put `run` on the session's clock: a new run resets the span, more frames of the same run
   *  extend it, and none clears it. */
  show(session: Session, run: RunInfo | undefined) {
    const { transport } = session
    const shown = session.run
    if (shown && run && shown.id !== run.id) session.previous = shown
    session.run = run
    if (!run) {
      session.previous = undefined
      session.window = undefined
      transport.clear()
      return
    }
    const live = run.state === 'running'
    if (shown?.id !== run.id) {
      session.plots = plotsFor(run, session.plots)
      this.persist(session)
    }
    // A run's span starts with its first frames.
    if (shown?.id !== run.id || (shown.frames === 0 && run.frames > 0)) {
      session.window = undefined
      transport.setSpan(run.domain, { live })
      return
    }
    transport.extend(run.domain[1])
    if (transport.noteHead(run.domain[1])) this.clock.fire(session.uri)
    transport.setLive(live)
  }
  /** Step one frame through the shown run, then pause. */
  async step(session: Session, direction: 1 | -1) {
    if (!session.run) return
    const t = await this.client.call('step', {
      run: session.run.id,
      at: session.transport.currentT(),
      direction,
    })
    session.transport.pause()
    session.transport.seek(t)
  }
  /** Set what future runs record. Plots of the current run are unaffected; the next run keeps those
   *  it records. */
  record(uri: string, outputs: readonly FieldSelection[]) {
    const session = this.all.get(uri)
    if (!session) return
    const recorded = outputs.filter(({ select }) => select.length > 0)
    session.outputs = recorded
    // With no run, keep only the plots the next run will record.
    if (!session.run)
      session.plots = session.plots.filter((plot) =>
        recorded.some(({ from, select }) => from === plot.from && select.includes(plot.field)),
      )
    this.persist(session)
    this.changed.fire(uri)
  }
  /** Make `field` drive exactly `channels`; a mapped sampled field joins future recordings. */
  bind(
    uri: string,
    field: FieldRef,
    channels: readonly Channel[],
    domain?: readonly [number, number],
  ) {
    const session = this.all.get(uri)
    const schema = this.documents.entries.get(uri)?.summary?.schema
    if (!session || !schema) throw new Error('Open a GridKit case first.')
    const allowed = channelsFor(placementOf(networkOf(schema), field.type))
    session.bindings = bound(session.bindings, allowed, field, channels, domain)
    if (channels.length && schema.types[field.type]?.fields[field.field]?.sampled) {
      const outputs = session.outputs ?? []
      const recorded = outputs.find((output) => output.from === field.type)
      if (!recorded) session.outputs = [...outputs, { from: field.type, select: [field.field] }]
      else if (!recorded.select.includes(field.field))
        session.outputs = outputs.map((output) =>
          output === recorded ? { ...output, select: [...output.select, field.field] } : output,
        )
    }
    this.persist(session)
    this.changed.fire(uri)
  }
  async dispose() {
    await Promise.all(
      [...this.all.values()]
        .filter((session) => session.run?.state === 'running')
        .map((session) => this.client.call('stop', { uri: session.uri }).catch(() => {})),
    )
    for (const session of this.all.values()) {
      await this.persist(session)
      session.transport.dispose()
    }
    this.documents.dispose()
    for (const disposable of this.disposables) disposable.dispose()
    this.changed.dispose()
    this.clock.dispose()
    this.action.dispose()
    this.output.dispose()
    return this.client.dispose()
  }
}
