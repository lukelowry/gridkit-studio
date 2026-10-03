import { type FieldSelection, sampledFields } from '@latkit/model'
import * as vscode from 'vscode'

import type { Bindings } from './bindings.js'
import { Client } from './client.js'
import { Documents } from './documents.js'
import type { Element, Plot, RunInfo, ViewState } from './messages.js'
import type { SettingsValues } from './preferences.js'
import { settingsFor } from './settings.js'

export interface Session {
  uri: string
  diagramEditing: boolean
  playing: boolean
  overlaps?: Element[]
  bindings: Bindings
  selection?: Element
  run?: RunInfo
  previous?: RunInfo
  at?: number
  plots: Plot[]
  outputs: FieldSelection[]
  values: Record<string, unknown>
  follow: boolean
  loop: 'none' | 'wrap' | 'pingpong'
  speed: number
  direction: 1 | -1
  settings: SettingsValues
  window?: readonly [number, number]
  table: { type?: string; fields?: string[]; filter?: string }
}
export class Sessions {
  readonly client: Client
  readonly documents: Documents
  readonly all = new Map<string, Session>()
  readonly changed = new vscode.EventEmitter<string>()
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
          session.playing = false
          this.changed.fire(session.uri)
        }
      }),
      this.documents.changed.event((uri) => {
        if (!this.documents.entries.has(uri)) {
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
        if (session.run && session.run.id !== event.info.id) session.previous = session.run
        session.run = event.info
        if (session.follow) session.at = event.info.domain[1]
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
      hasRun: !!session?.run,
      hasSamples: (session?.run?.frames ?? 0) > 0,
      playing: !!session?.playing,
      following: !!session?.follow,
      looping: session?.loop !== undefined && session.loop !== 'none',
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
        follow: true,
        loop: 'none',
        speed: 1,
        direction: 1,
        playing: false,
        diagramEditing: false,
        settings: settingsFor(vscode.Uri.parse(uri)),
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
        .get('navigateOnSelection', true),
      diagramEditing: session?.diagramEditing,
      settings: session?.settings,
      playing: session?.playing,
      follow: session?.follow,
      loop: session?.loop,
      speed: session?.speed,
      bindings: session?.bindings,
      summary: entry?.summary,
      stale: entry?.stale,
      selection: session?.selection,
      run: session?.run,
      at: session?.at,
      plots: session?.plots,
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
  async dispose() {
    await Promise.all(
      [...this.all.values()]
        .filter((session) => session.run?.state === 'running')
        .map((session) => this.client.call('stop', { uri: session.uri }).catch(() => {})),
    )
    for (const session of this.all.values()) this.persist(session)
    this.documents.dispose()
    for (const disposable of this.disposables) disposable.dispose()
    this.changed.dispose()
    this.action.dispose()
    this.output.dispose()
    return this.client.dispose()
  }
}
