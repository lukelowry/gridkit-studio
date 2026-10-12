/** Every case Studio works on, each a Session kept while something holds it, and what they share:
 *  the workers, the open documents, the log, and the events the views and native UI follow. */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as vscode from 'vscode'

import type { Target } from '../shared/contexts.js'
import { failedWith, superseded } from '../shared/errors.js'
import {
  type Command,
  commandId,
  type ContextKey,
  contextKey,
  followed,
  savedKey,
  savedUri,
} from '../shared/ids.js'
import type { CaseSource, Summary, ViewAction, ViewState, WorkerEvent } from '../shared/messages.js'
import { resent } from '../shared/rpc.js'
import { Client, CRASHES } from './client.js'
import { Documents, isWritable } from './documents.js'
import { noCase, Reporter } from './report.js'
import { type Hold, savedResults, Session } from './session.js'
import { affects, cacheBytes } from './settings.js'
import { gone } from './solvers.js'

/** A command's ask of the views of a case: of every one, or of those of the kind its menu was
 *  opened on. */
export interface Action {
  readonly uri: string
  readonly command: ViewAction
  readonly value?: unknown
  readonly view?: Target['origin']
}

export class Sessions implements vscode.Disposable {
  readonly reporter = new Reporter()
  readonly client: Client
  readonly documents: Documents
  /** Fires when what a case's views show changes. */
  readonly changed = new vscode.EventEmitter<string>()
  /** Fires when a case's clock changes or its following playhead moves with the head. */
  readonly clock = new vscode.EventEmitter<string>()
  readonly action = new vscode.EventEmitter<Action>()
  /** The context keys Studio last set, as VS Code holds them. */
  readonly contexts = new Map<ContextKey, unknown>()
  /** The Monitored Signals row of `type`'s `field`, as VS Code holds it, for the tests: what its
   *  menu offers, and what it carries to the commands there. */
  signalRow?: (type: string, field: string) => vscode.TreeItem | undefined
  readonly #all = new Map<string, Session>()
  #active?: Session
  readonly #disposables: vscode.Disposable[]

  constructor(readonly context: vscode.ExtensionContext) {
    // The runs of every window on this machine are written down in one folder.
    const { globalStorageUri, storageUri, workspaceState } = context
    const runs =
      globalStorageUri.scheme === 'file'
        ? vscode.Uri.joinPath(globalStorageUri, 'runs').fsPath
        : undefined
    // The results read are kept with the workspace, where its sessions are saved.
    const kept = [storageUri, globalStorageUri].find((uri) => uri?.scheme === 'file')
    const store = kept
      ? vscode.Uri.joinPath(kept, 'results').fsPath
      : join(tmpdir(), `gridkit-studio-results-${process.pid}`)
    this.client = new Client(vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath, () => ({
      cacheBytes: cacheBytes(),
      store,
      saved: savedResults(workspaceState),
      ...(runs && { runs }),
    }))
    this.documents = new Documents(this.client, (error) => this.reporter.report(error))
    this.#disposables = [
      this.changed.event(() => this.updateContexts()),
      // Either worker stopping is said. A new results worker holds none of the old one's results,
      // so each session reads its own again.
      this.client.cases.failure.event((error) =>
        this.reporter.report(this.documents.restart(error)),
      ),
      this.client.results.failure.event((error) => {
        const { steady } = this.client.results
        this.reporter.report(
          steady
            ? error
            : new Error(
                `${error.message} It stopped ${CRASHES} times in a minute, so Studio reads ` +
                  'results again once you show them.',
              ),
        )
        for (const session of this.#all.values()) session.lost(error, steady)
      }),
      // An open case document holds its session.
      this.documents.opened.event((uri) => this.hold(uri, 'document')),
      this.documents.closed.event((uri) => this.release(uri, 'document')),
      this.documents.changed.event((uri) => {
        this.changed.fire(uri)
        const session = this.#all.get(uri)
        if (!session || this.documents.get(uri)?.stale) return
        void session.forget()
        session.restore('read')
      }),
      this.client.event.event((event) => this.#hear(event)),
      // A case's saved state follows it when it is renamed or moved, and goes when it is deleted.
      vscode.workspace.onDidRenameFiles(({ files }) => {
        for (const { oldUri, newUri } of files) this.#move(oldUri.toString(), newUri.toString())
      }),
      vscode.workspace.onDidDeleteFiles(({ files }) => {
        for (const uri of files) this.#move(uri.toString())
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        for (const session of this.#all.values())
          if (affects(event, vscode.Uri.parse(session.uri))) session.reconfigure()
        if (affects(event, undefined, 'resultCacheMiB') && this.client.results.running)
          void this.client.results
            .call('configure', { cacheBytes: cacheBytes() })
            .catch((error) => this.reporter.error(error))
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && followed(editor.document.uri.toString()))
          void this.open(editor.document).catch((error) => this.reporter.error(error))
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
        if (input instanceof vscode.TabInputCustom && followed(input.uri.toString()))
          this.activate(input.uri.toString())
      }),
    ]
    void this.prune()
  }

  /** Registers the command `id`, reporting why it fails. */
  command(id: Command, run: (...args: unknown[]) => unknown): vscode.Disposable {
    return vscode.commands.registerCommand(commandId(id), async (...args: unknown[]) => {
      try {
        return await run(...args)
      } catch (error) {
        this.reporter.report(error)
      }
    })
  }

  /** The case the views follow. */
  get active(): string | undefined {
    return this.#active?.uri
  }

  /** The session of the case at `uri`, while something holds it. */
  get(uri: string): Session | undefined {
    return this.#all.get(uri)
  }

  /** The session the views follow. */
  current(): Session {
    if (!this.#active) throw noCase()
    return this.#active
  }

  /** The session of `uri`, held for `why`: made, and what it saved read again, as it is first held. */
  hold(uri: string, why: Hold): Session {
    let session = this.#all.get(uri)
    if (!session) this.#all.set(uri, (session = new Session(uri, this)))
    session.hold(why)
    return session
  }

  /** Lets go of `uri`'s session for `why`; once nothing holds it, it closes. */
  release(uri: string, why: Hold): void {
    this.#all.get(uri)?.release(why)
  }

  /** Hears from a session that closes. */
  closed(session: Session): void {
    if (this.#all.get(session.uri) !== session) return
    this.#all.delete(session.uri)
    if (this.#active === session) this.#active = undefined
    this.changed.fire(session.uri)
  }

  /** Makes `uri`'s case the one the views follow, letting go of the one they followed. */
  activate(uri: string): Session {
    // Tabs change often, as a case's editor turns dirty: only another case is news, but for
    // results due to be read again as the views follow it.
    if (this.#active?.uri === uri) {
      this.#active.restore('following')
      return this.#active
    }
    const previous = this.#active
    this.#active = this.hold(uri, 'active')
    this.changed.fire(uri)
    previous?.release('active')
    return this.#active
  }

  /** Follows the case `document` holds, and reads it. */
  async open(document: vscode.TextDocument): Promise<Session> {
    const session = this.activate(document.uri.toString())
    await this.documents.ensure(document)
    return session
  }

  /** The case at `uri` as it reads now, opening its document if VS Code has let go of it. */
  async caseOf(uri: string): Promise<{ document: vscode.TextDocument; summary: Summary }> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
    return { document, summary: await this.documents.read(document) }
  }

  /** Asks the results worker `call` of the case at `uri` as it reads now: by its fingerprint, and
   *  with its source too only when the worker has yet to read it. A large case crosses once. Its
   *  source crosses only as the fingerprint says it reads; edited since, the case is read again. */
  async withCase<T>(uri: string, call: (source: CaseSource) => Promise<T>): Promise<T> {
    for (;;) {
      const { document, summary } = await this.caseOf(uri)
      const source = { uri, version: summary.version, fingerprint: summary.fingerprint }
      try {
        return await resent(call, 'needs-source', source, () => {
          if (document.version !== summary.version) throw superseded()
          return { ...source, text: document.getText() }
        })
      } catch (error) {
        if (!failedWith(error, 'superseded') || document.isClosed) throw error
      }
    }
  }

  /** Lets go of the results `id` names in the results worker, which a worker that stopped holds no
   *  more. */
  closeResults(id: string): void {
    if (this.client.results.running)
      void this.client.results.call('close', { results: id }).catch(() => {})
  }

  /** What the views of the case at `uri` show. */
  state(uri: string): ViewState {
    const entry = this.documents.get(uri)
    const session = this.#all.get(uri)
    return {
      uri,
      version: entry?.document.version,
      writable: !!entry && isWritable(entry.document),
      diagramEditing: session?.diagramEditing,
      settings: session?.settings,
      bindings: session?.bindings,
      summary: entry?.summary,
      stale: entry?.stale,
      error: entry?.error,
      selection: session?.selection,
      anchors: session?.anchors,
      results: session?.results,
      plots: session?.plots,
      window: session?.window,
      table: session?.table,
    }
  }

  /** Sets the context keys the manifest's `when` clauses read, each only when it changes. */
  updateContexts(): void {
    const session = this.#active
    const entry = session && this.documents.get(session.uri)
    const values: Record<ContextKey, boolean> = {
      hasCase: !!session,
      diagramEditing: !!session?.diagramEditing,
      editable: !!entry && !entry.stale && isWritable(entry.document),
      running: !!session?.running,
      fromSolver: !!session?.results?.solver,
      hasResults: !!session?.results,
      hasSamples: (session?.results?.frames ?? 0) > 0,
      hasSelection: !!session?.selection,
      caseReady: !!entry?.summary,
      caseFiltered: !!(session?.table.filter || session?.table.equal),
    }
    for (const [key, value] of Object.entries(values) as [ContextKey, boolean][])
      if (this.contexts.get(key) !== value) {
        this.contexts.set(key, value)
        void vscode.commands.executeCommand('setContext', contextKey(key), value)
      }
  }

  /** Drops the saved state of cases that no longer exist, as one deleted while VS Code was closed,
   *  and of copies the views never follow, as Git's of an older version. A case that cannot be
   *  reached now, on a remote or network drive, keeps its state. */
  async prune(): Promise<void> {
    const { workspaceState } = this.context
    await Promise.all(
      workspaceState.keys().map(async (key) => {
        const uri = savedUri(key)
        if (uri === undefined) return
        if (!followed(uri) || (await gone(vscode.Uri.parse(uri))))
          await workspaceState.update(key, undefined)
      }),
    )
  }

  /** Moves the saved state of the cases at or under `from` to `to`, or drops it with no `to`. Their
   *  sessions save under their old names no more. */
  #move(from: string, to?: string): void {
    const under = (uri: string) => uri === from || uri.startsWith(from + '/')
    for (const session of this.#all.values()) if (under(session.uri)) session.moved()
    const { workspaceState } = this.context
    for (const key of workspaceState.keys()) {
      const uri = savedUri(key)
      if (uri === undefined || !under(uri)) continue
      const saved = workspaceState.get(key)
      void workspaceState.update(key, undefined)
      if (to !== undefined) void workspaceState.update(savedKey(to + uri.slice(from.length)), saved)
    }
  }

  /** What a worker tells besides its replies: a line for the log, how far results are read, or how
   *  a run stands. */
  #hear(event: Exclude<WorkerEvent, { kind: 'process' }>): void {
    if (event.kind === 'results')
      return this.#all.get(event.uri)?.reading(event.results, event.progress, event.layout)
    if (event.kind === 'run') return this.#all.get(event.run.uri)?.ran(event.run)
    const { output } = this.reporter
    // A line of a case's run at its own level, and as GridKit printed it only at Trace.
    if (event.uri) {
      output[event.level ?? 'info'](event.message)
      if (event.raw) output.trace(event.raw)
    } else if (event.level === 'error') this.reporter.error(event.message)
    else if (event.level === 'warn') output.warn(event.message)
    else output.appendLine(event.message)
  }

  async dispose(): Promise<void> {
    for (const session of this.#all.values()) session.dispose()
    this.documents.dispose()
    for (const disposable of this.#disposables) disposable.dispose()
    this.changed.dispose()
    this.clock.dispose()
    this.action.dispose()
    this.reporter.dispose()
    await this.client.dispose()
  }
}
