import { type FieldSelection, sampledFields } from '@latkit/model'
import * as vscode from 'vscode'

import { Client } from './client.js'
import { Documents } from './documents.js'
import type { Element, Plot, RunInfo, ViewState } from './messages.js'

export interface Session {
  playing?: boolean
  overlaps?: Element[]
  configurationResolved?: boolean
  bindings: Record<string, string>
  uri: string
  selection?: Element
  run?: RunInfo
  previous?: RunInfo
  at?: number
  plots: Plot[]
  outputs: FieldSelection[]
  values: Record<string, unknown>
  configuration?: vscode.Uri
  follow: boolean
  loop: boolean
  speed: number
}
export class Sessions {
  readonly client: Client
  readonly documents: Documents
  readonly all = new Map<string, Session>()
  readonly changed = new vscode.EventEmitter<string>()
  readonly action = new vscode.EventEmitter<{ uri: string; command: string; value?: unknown }>()
  readonly output = vscode.window.createOutputChannel('GridKit Studio', { log: true })
  readonly disposables: vscode.Disposable[] = []
  active?: string
  constructor(readonly context: vscode.ExtensionContext) {
    this.client = new Client(context)
    this.documents = new Documents(this.client)
    this.disposables.push(
      this.client.failure.event((error) => {
        for (const session of this.all.values())
          if (session.run?.state === 'running') {
            session.run.state = 'failed'
            session.run.message = error.message
            this.changed.fire(session.uri)
          }
        void vscode.commands.executeCommand('setContext', 'gridkitStudio.running', false)
      }),
    )
    this.disposables.push(
      this.documents.changed.event((uri) => {
        if (!this.documents.entries.has(uri)) {
          this.all.delete(uri)
          if (this.active === uri) {
            this.active = this.all.keys().next().value
            void vscode.commands.executeCommand(
              'setContext',
              'gridkitStudio.hasCase',
              !!this.active,
            )
          }
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
        if (this.active === session.uri)
          void vscode.commands.executeCommand(
            'setContext',
            'gridkitStudio.running',
            event.info.state === 'running',
          )
        this.changed.fire(session.uri)
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && /\.case\.json$/i.test(editor.document.fileName))
          this.activate(editor.document.uri.toString())
      }),
    )
  }
  activate(uri: string) {
    this.active = uri
    if (!this.all.has(uri))
      this.all.set(uri, {
        uri,
        bindings: {},
        plots: [],
        outputs: [],
        values: {},
        follow: true,
        loop: false,
        speed: 1,
      })
    void vscode.commands.executeCommand('setContext', 'gridkitStudio.hasCase', true)
    void vscode.commands.executeCommand(
      'setContext',
      'gridkitStudio.running',
      this.all.get(uri)?.run?.state === 'running',
    )
    this.changed.fire(uri)
    return this.all.get(uri)!
  }
  async open(document: vscode.TextDocument) {
    const session = this.activate(document.uri.toString())
    const summary = await this.documents.ensure(document)
    if (!session.configurationResolved) {
      session.configurationResolved = true
      const uri = document.uri.with({
        path: document.uri.path.replace(/\.case\.json$/i, '.solver.json'),
      })
      if (uri.toString() !== document.uri.toString()) {
        try {
          await vscode.workspace.fs.stat(uri)
          session.configuration = uri
        } catch {
          /* The form handles cases without a solver file. */
        }
      }
    }
    if (!session.outputs.length)
      session.outputs = sampledFields(summary.schema).filter((f) => summary.counts[f.from])
    return session
  }
  current() {
    if (!this.active) throw new Error('Open a GridKit case first.')
    return this.all.get(this.active)!
  }
  state(uri: string): ViewState {
    const entry = this.documents.entries.get(uri)
    const session = this.all.get(uri)
    const settings = vscode.workspace.getConfiguration('gridkitStudio', vscode.Uri.parse(uri))
    return {
      navigate: settings.get('navigateOnSelection', true),
      branchColors: settings.get('branchColorsFromBuses', true),
      playing: session?.playing,
      follow: session?.follow,
      bindings: session?.bindings,
      summary: entry?.summary,
      stale: entry?.stale,
      selection: session?.selection,
      run: session?.run,
      at: session?.at,
      plots: session?.plots,
    }
  }
  select(uri: string, element: Element) {
    const session = this.activate(uri)
    session.selection = element
    this.changed.fire(uri)
  }
  async dispose() {
    await Promise.all(
      [...this.all.values()]
        .filter((session) => session.run?.state === 'running')
        .map((session) => this.client.call('stop', { uri: session.uri }).catch(() => {})),
    )
    this.documents.dispose()
    for (const disposable of this.disposables) disposable.dispose()
    this.changed.dispose()
    this.action.dispose()
    this.output.dispose()
    return this.client.dispose()
  }
}
