import { type FieldSelection, sampledFields } from '@latkit/model'
import * as vscode from 'vscode'

import { type Bindings, bound, type Channel, channelsFor, type FieldRef } from './bindings.js'
import { Client } from './client.js'
import { Documents } from './documents.js'
import type { Cameras, Element, Plot, RunInfo, TableState, ViewState } from './messages.js'
import type { SettingsValues } from './preferences.js'
import { networkOf, placementOf } from './schema.js'
import { settingsFor } from './settings.js'
import { Transport } from './transport.js'

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
  outputs: FieldSelection[]
  values: Record<string, unknown>
  /** The case's playhead: it changes here, and every view integrates it between changes. */
  transport: Transport
  settings: SettingsValues
  /** The times the Monitor's reader chose to show; absent, the plots show the run. */
  window?: readonly [number, number]
  cameras: Cameras
  table: TableState
}
export class Sessions {
  readonly client: Client
  readonly documents: Documents
  readonly all = new Map<string, Session>()
  readonly changed = new vscode.EventEmitter<string>()
  /** A case's clock changed, or its following playhead moved with the head. */
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
      editable:
        !!entry &&
        !entry.stale &&
        vscode.workspace.fs.isWritableFileSystem(entry.document.uri.scheme) !== false,
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
      const saved = this.context.workspaceState.get<
        Partial<Pick<Session, 'bindings' | 'values' | 'plots' | 'table'>>
      >('case:' + uri, {})
      this.all.set(uri, {
        uri,
        bindings: saved.bindings ?? {},
        plots: saved.plots ?? [],
        outputs: [],
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
    if (!session.outputs.length)
      session.outputs = sampledFields(summary.schema).filter((field) => summary.counts[field.from])
    return session
  }
  current() {
    const session = this.active ? this.all.get(this.active) : undefined
    if (!session) throw new Error('Open a GridKit case first.')
    return session
  }
  persist(session: Session) {
    void this.context.workspaceState.update('case:' + session.uri, {
      bindings: session.bindings,
      values: session.values,
      plots: session.plots,
      table: session.table,
    })
  }
  state(uri: string): ViewState {
    const entry = this.documents.entries.get(uri)
    const session = this.all.get(uri)
    return {
      uri,
      version: entry?.document.version,
      writable:
        !!entry && vscode.workspace.fs.isWritableFileSystem(entry.document.uri.scheme) !== false,
      navigate: vscode.workspace
        .getConfiguration('gridkitStudio', vscode.Uri.parse(uri))
        .get('navigateOnSelection', false),
      diagramEditing: session?.diagramEditing,
      settings: session?.settings,
      bindings: session?.bindings,
      editing: session?.editing,
      summary: entry?.summary,
      stale: entry?.stale,
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
  /** Show `run` on `session`'s clock: another run takes its span over, and the frames of the one on
   *  show extend it; none stills the clock. */
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
    // A run's span starts where its first frames do.
    if (shown?.id !== run.id || (shown.frames === 0 && run.frames > 0)) {
      session.window = undefined
      transport.setSpan(run.domain, { live })
      return
    }
    transport.extend(run.domain[1])
    if (transport.noteHead(run.domain[1])) this.clock.fire(session.uri)
    transport.setLive(live)
  }
  /** Step one frame of the run on show, and pause there. */
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
  /** Record `field` of every `type` element in the runs to come, or stop; a signal no longer
   *  recorded is no longer plotted. */
  record(uri: string, type: string, field: string, on: boolean) {
    const session = this.all.get(uri)
    if (!session) return
    const others = session.outputs.filter((output) => output.from !== type)
    const select = (session.outputs.find((output) => output.from === type)?.select ?? []).filter(
      (name) => name !== field,
    )
    if (on) select.push(field)
    session.outputs = select.length ? [...others, { from: type, select }] : others
    if (!on)
      session.plots = session.plots.filter((plot) => plot.from !== type || plot.field !== field)
    this.persist(session)
    this.changed.fire(uri)
  }
  /** Make `field` drive exactly `channels`. A mapped signal is recorded by the runs to come. */
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
      const recorded = session.outputs.find((output) => output.from === field.type)
      if (!recorded)
        session.outputs = [...session.outputs, { from: field.type, select: [field.field] }]
      else if (!recorded.select.includes(field.field))
        session.outputs = session.outputs.map((output) =>
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
      this.persist(session)
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
