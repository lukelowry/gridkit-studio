/** The open sessions, one per case, and what they share: the worker, the case files, the log and
 *  the events the views and native UI listen to. */

import * as vscode from 'vscode'

import { createHash } from '../platform/crypto.js'
import { browser, tmpdir } from '../platform/host.js'
import { join } from '../platform/path.js'
import { failedWith } from '../shared/errors.js'
import {
  type Command,
  commandId,
  type ContextKey,
  contextKey,
  isCaseFile,
  savedKey,
  savedUri,
  type View,
  viewId,
} from '../shared/ids.js'
import {
  type Revision,
  revisionOf,
  type ViewAction,
  type ViewKind,
  type ViewState,
  type WorkerEvent,
} from '../shared/messages.js'
import { Client } from './client.js'
import { CaseFiles } from './files.js'
import { Reporter } from './report.js'
import { type Hold, savedResults, Session } from './session.js'
import { affects, cacheBytes } from './settings.js'
import { gone } from './solvers.js'
import { reference } from './uris.js'

/** A command sent to a case's views: all of them, or only those of the kind whose menu ran it. */
export interface Action {
  readonly uri: string
  readonly command: ViewAction
  readonly view?: ViewKind
  /** Only the active editor acts, as for an editor title bar command. */
  readonly active?: boolean
}

export class Studio implements vscode.Disposable {
  readonly client: Client
  readonly files: CaseFiles
  /** Fires when a case's view state changes. */
  readonly changed = new vscode.EventEmitter<string>()
  /** Fires when a case's clock changes or a following playhead moves with the head. */
  readonly clock = new vscode.EventEmitter<string>()
  readonly action = new vscode.EventEmitter<Action>()
  readonly contexts = new Map<ContextKey, unknown>()
  /** The resolved panel views, used by `showView`. */
  readonly panels = new Map<Extract<View, 'case' | 'monitor' | 'export'>, vscode.WebviewView>()
  readonly #sessions = new Map<string, Session>()
  #active?: Session
  readonly #disposables: vscode.Disposable[]

  constructor(
    readonly context: vscode.ExtensionContext,
    readonly reporter = new Reporter(),
  ) {
    // Every window on this machine records its runs in one shared folder.
    const { globalStorageUri, storageUri, workspaceState } = context
    const runs =
      !browser && globalStorageUri.scheme === 'file'
        ? vscode.Uri.joinPath(globalStorageUri, 'runs').fsPath
        : undefined
    // The results store lives with the workspace, where sessions are saved. Windows that share a
    // storage folder (empty windows) each get their own store.
    const kept = [storageUri, globalStorageUri].find((uri) => uri?.scheme === 'file')
    const store = browser
      ? `opfs:/gridkit/stores/${createHash('sha256')
          .update((storageUri ?? globalStorageUri).toString())
          .digest('hex')}`
      : kept
        ? vscode.Uri.joinPath(kept, 'results').fsPath
        : join(tmpdir(), 'gridkit-studio-results')
    this.client = new Client(
      reference(vscode.Uri.joinPath(context.extensionUri, 'dist')),
      () => ({
        cacheBytes: cacheBytes(),
        store,
        saved: savedResults(workspaceState),
        ...(runs && { runs }),
      }),
      (error) => this.reporter.report(error),
    )
    this.files = new CaseFiles(this.client, (error) => this.reporter.report(error))
    this.#disposables = [
      this.changed.event(() => this.updateContexts()),
      // A new worker has none of the old one's cases or results, so files and results are read
      // again. Results being read during the crash, which may have caused it, wait for the user.
      this.client.worker.failure.event((error) => {
        this.files.restart(error)
        for (const session of this.#sessions.values()) session.lost(error)
        this.reporter.report(error)
      }),
      this.files.changed.event((uri) => {
        this.changed.fire(uri)
        const session = this.#sessions.get(uri)
        if (!session || this.files.get(uri)?.stale) return
        void session.reselect()
        session.restore('read')
      }),
      this.client.event.event((event) => this.#handleEvent(event)),
      // Saved state follows a renamed or moved case and is dropped for a deleted one.
      vscode.workspace.onDidRenameFiles(({ files }) => {
        for (const { oldUri, newUri } of files) this.#move(oldUri.toString(), newUri.toString())
      }),
      vscode.workspace.onDidDeleteFiles(({ files }) => {
        for (const uri of files) this.#move(uri.toString())
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        for (const session of this.#sessions.values())
          if (affects(event, vscode.Uri.parse(session.uri))) session.reconfigure()
        if (affects(event, undefined, 'resultCacheMiB') && this.client.worker.running)
          void this.client.worker
            .call('configure', { cacheBytes: cacheBytes() })
            .catch((error) => this.reporter.report(error))
      }),
      // Only a tab or group becoming active changes the active case, not one changing behind it.
      vscode.window.tabGroups.onDidChangeTabs(({ opened, changed }) => {
        if ([...opened, ...changed].some((tab) => tab.isActive && tab.group.isActive))
          this.#followActiveTab()
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(({ changed }) => {
        if (changed.some((group) => group.isActive)) this.#followActiveTab()
      }),
    ]
    void this.prune()
    // A case restored in the active tab at startup becomes the active case.
    this.#followActiveTab()
  }

  #followActiveTab(): void {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const uri =
      input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText
        ? input.uri.toString()
        : undefined
    if (uri && isCaseFile(uri)) this.activate(uri)
  }

  command(id: Command, run: (...args: unknown[]) => unknown): vscode.Disposable {
    return vscode.commands.registerCommand(commandId(id), async (...args: unknown[]) => {
      try {
        return await run(...args)
      } catch (error) {
        this.reporter.report(error)
      }
    })
  }

  /** Shows the panel `kind` without taking focus. A panel never resolved can only be shown by
   *  focusing it. */
  async showView(kind: Extract<View, 'case' | 'monitor' | 'export'>): Promise<void> {
    const view = this.panels.get(kind)
    if (view)
      try {
        return view.show(true)
      } catch {
        // VS Code disposed it before firing onDidDispose; the focus command recreates it.
        this.panels.delete(kind)
      }
    await vscode.commands.executeCommand(viewId(kind) + '.focus')
  }

  get active(): string | undefined {
    return this.#active?.uri
  }

  get(uri: string): Session | undefined {
    return this.#sessions.get(uri)
  }

  /** Holds `uri`'s session for `why`, creating it and watching its file on first hold. */
  hold(uri: string, why: Hold): Session {
    let session = this.#sessions.get(uri)
    if (!session) {
      // Watch the file before the session reads anything from it.
      this.files.open(uri)
      this.#sessions.set(uri, (session = new Session(uri, this)))
    }
    session.hold(why)
    return session
  }

  release(uri: string, why: Hold): void {
    this.#sessions.get(uri)?.release(why)
  }

  /** Called by a session as it closes. */
  closed(session: Session): void {
    if (this.#sessions.get(session.uri) !== session) return
    this.#sessions.delete(session.uri)
    this.files.close(session.uri)
    if (this.#active === session) this.#active = undefined
    this.changed.fire(session.uri)
  }

  /** Makes `uri` the active case and releases the previous one. Only case files on disk qualify,
   *  never a copy shown by another extension. */
  activate(uri: string): Session {
    if (!isCaseFile(uri)) throw new Error('Open a saved .case.json file.')
    // Tabs change often (an editor turning dirty), so the same case only restores pending results.
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

  async open(uri: string): Promise<Session> {
    const session = this.activate(uri)
    await this.files.read(uri)
    return session
  }

  /** Calls the worker with the case's current revision, retrying with the newer revision when the
   *  file is read again meanwhile. */
  async withCase<T>(uri: string, call: (revision: Revision) => Promise<T>): Promise<T> {
    for (;;) {
      const summary = await this.files.read(uri)
      try {
        return await call(revisionOf(summary))
      } catch (error) {
        if (!failedWith(error, 'superseded')) throw error
      }
    }
  }

  /** Closes the results `id` in the worker; a stopped worker no longer has them. */
  closeResults(id: string): void {
    if (this.client.worker.running)
      void this.client.worker.call('close', { results: id }).catch(() => {})
  }

  state(uri: string): ViewState {
    const file = this.files.get(uri)
    const session = this.#sessions.get(uri)
    return {
      uri,
      settings: session?.settings,
      exportSettings: session?.exportSettings,
      mappings: session?.mappings,
      summary: file?.summary,
      stale: file?.stale,
      error: file?.error,
      selection: session?.selection,
      networkSelection: session?.networkSelection,
      results: session?.results,
      monitors: session?.monitors,
      shown: session?.shown,
      window: session?.window,
      table: session?.table,
    }
  }

  /** Sets the context keys the manifest's `when` clauses read, each only when it changes. */
  updateContexts(): void {
    const session = this.#active
    const file = session && this.files.get(session.uri)
    const values: Record<ContextKey, boolean> = {
      hasCase: !!session,
      running: !!session?.running,
      hasResults: !!session?.results,
      hasSamples: (session?.results?.frames ?? 0) > 0,
      hasSelection: !!session?.selection,
      caseReady: !!file?.summary,
      caseFiltered: !!(session?.table.filter || session?.table.equal),
      canSplit: !!session && session.monitors.length > session.shown.length,
    }
    for (const [key, value] of Object.entries(values) as [ContextKey, boolean][])
      if (this.contexts.get(key) !== value) {
        this.contexts.set(key, value)
        void vscode.commands.executeCommand('setContext', contextKey(key), value)
      }
  }

  /** Drops workspace state other than the saved state of existing cases, including cases deleted
   *  while VS Code was closed. A case that is unreachable now (remote or network drive) is kept. */
  async prune(): Promise<void> {
    const { workspaceState } = this.context
    await Promise.all(
      workspaceState.keys().map(async (key) => {
        const uri = savedUri(key)
        if (uri === undefined || !isCaseFile(uri) || (await gone(vscode.Uri.parse(uri))))
          await workspaceState.update(key, undefined)
      }),
    )
  }

  /** Moves the saved state of cases at or under `from` to `to`, or drops it without `to`. */
  #move(from: string, to?: string): void {
    const under = (uri: string) => uri === from || uri.startsWith(from + '/')
    for (const session of this.#sessions.values()) if (under(session.uri)) session.moved()
    const { workspaceState } = this.context
    for (const key of workspaceState.keys()) {
      const uri = savedUri(key)
      if (uri === undefined || !under(uri)) continue
      const saved = workspaceState.get(key)
      void workspaceState.update(key, undefined)
      if (to === undefined) continue
      const moved = to + uri.slice(from.length)
      void workspaceState.update(savedKey(moved), saved)
      // A session already created under the new name adopts the moved state.
      this.#sessions.get(moved)?.resume(saved)
    }
  }

  #handleEvent(event: Exclude<WorkerEvent, { kind: 'process' }>): void {
    if (event.kind === 'results')
      return this.#sessions.get(event.uri)?.reading(event.results, event.progress, event.layout)
    if (event.kind === 'run') return this.#sessions.get(event.run.uri)?.ran(event.run)
    if (event.kind === 'lost') return this.#sessions.get(event.uri)?.dropped(event.results)
    const { output } = this.reporter
    // A run's line logs at its own level; GridKit's raw output only at Trace.
    if (event.uri) {
      output[event.level ?? 'info'](event.message)
      if (event.raw) output.trace(event.raw)
    } else if (event.level === 'error') this.reporter.error(event.message)
    else if (event.level === 'warn') output.warn(event.message)
    else output.appendLine(event.message)
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions.values()) session.dispose()
    this.files.dispose()
    for (const disposable of this.#disposables) disposable.dispose()
    this.changed.dispose()
    this.clock.dispose()
    this.action.dispose()
    this.reporter.dispose()
    await this.client.dispose()
  }
}
