import type { Value } from '@latkit/model'
import * as vscode from 'vscode'

import type { Element, Mutation, Revision, SourceEdit, Summary } from '../shared/messages.js'
import type { Client } from './client.js'

/** Whether `document` can be edited; a file system VS Code does not know counts as writable. */
export function isWritable(document: vscode.TextDocument) {
  return vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) !== false
}

interface Entry {
  document: vscode.TextDocument
  summary?: Summary
  pending?: Promise<Summary>
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  /** The version the worker's source mirror holds. */
  workerVersion?: number
  /** Edits since `workerVersion`, sent as a delta on the next parse. */
  changes: SourceEdit[][]
  editing?: Promise<void>
  stale: boolean
  error?: string
  diagnosticsVersion?: number
}
/** A worker that stops this many times within `CRASH_MS` is not restarted to read the cases again
 *  until one of them changes. */
const CRASHES = 3
const CRASH_MS = 60_000

export class Documents {
  readonly entries = new Map<string, Entry>()
  readonly changed = new vscode.EventEmitter<string>()
  readonly diagnostics = vscode.languages.createDiagnosticCollection('gridkit')
  readonly disposables: vscode.Disposable[]
  /** When the worker last stopped. */
  #crashes: number[] = []
  constructor(readonly client: Client) {
    this.disposables = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        const entry = this.entries.get(event.document.uri.toString())
        if (!entry || !event.contentChanges.length) return
        entry.changes.push(
          event.contentChanges.map((change) => ({
            offset: change.rangeOffset,
            length: change.rangeLength,
            text: change.text,
          })),
        )
        entry.stale = true
        entry.controller?.abort()
        entry.pending = undefined
        clearTimeout(entry.timer)
        this.changed.fire(event.document.uri.toString())
        entry.timer = setTimeout(() => {
          void this.parse(event.document).catch(() => {})
        }, 150)
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const uri = document.uri.toString()
        const entry = this.entries.get(uri)
        if (!entry) return
        entry.controller?.abort()
        clearTimeout(entry.timer)
        this.entries.delete(uri)
        this.changed.fire(uri)
        this.diagnostics.delete(document.uri)
        void this.client.call('release', { uri }).catch(() => {})
      }),
      // A new worker reads the open cases again, unless the reading may be what stops it.
      this.client.failure.event((error) => {
        const now = Date.now()
        this.#crashes = [...this.#crashes.filter((time) => now - time < CRASH_MS), now]
        const retry = this.#crashes.length < CRASHES
        for (const [uri, entry] of this.entries) {
          entry.controller?.abort()
          clearTimeout(entry.timer)
          entry.stale = true
          entry.error = retry
            ? error.message
            : `${error.message} It stopped ${CRASHES} times in a minute, so Studio reads the case again once you edit or reopen it.`
          entry.workerVersion = undefined
          entry.changes = []
          entry.pending = undefined
          this.changed.fire(uri)
          if (retry) void this.parse(entry.document).catch(() => {})
        }
      }),
    ]
  }
  async ensure(document: vscode.TextDocument): Promise<Summary> {
    const entry = this.entries.get(document.uri.toString())
    if (entry?.summary?.version === document.version && !entry.stale) return entry.summary
    return entry?.pending ?? this.parse(document)
  }
  /** Require an explicitly captured, still-current projection. */
  require(revision: Revision): Summary {
    const entry = this.entries.get(revision.uri)
    if (!entry || entry.document.isClosed) throw new Error('The case document is closed.')
    if (
      entry.stale ||
      entry.document.version !== revision.version ||
      entry.summary?.version !== revision.version
    )
      throw new Error('The document changed or is invalid. Inspect the case again.')
    return entry.summary
  }
  parse(document: vscode.TextDocument): Promise<Summary> {
    const uri = document.uri.toString()
    let entry = this.entries.get(uri)
    if (!entry) {
      entry = { document, stale: true, changes: [] }
      this.entries.set(uri, entry)
    }
    entry.controller?.abort()
    clearTimeout(entry.timer)
    const controller = (entry.controller = new AbortController())
    const version = document.version
    const current = entry
    const input =
      entry.workerVersion !== undefined && entry.changes.length
        ? { uri, version, baseVersion: entry.workerVersion, changes: entry.changes }
        : { uri, version, text: document.getText() }
    entry.changes = []
    entry.workerVersion = version
    const pending = this.client
      .call('parse', input, controller.signal)
      .catch((error) => {
        // The worker's mirror is not at the delta's base: resend the whole text.
        if (
          error.message === 'Source mirror is stale.' &&
          !controller.signal.aborted &&
          document.version === version
        )
          return this.client.call(
            'parse',
            { uri, version, text: document.getText() },
            controller.signal,
          )
        throw error
      })
      .then(
        (summary) => {
          if (document.version !== version || controller.signal.aborted)
            throw new Error('Superseded revision')
          current.summary = summary
          current.stale = false
          current.error = undefined
          current.diagnosticsVersion = version
          this.diagnostics.set(
            document.uri,
            summary.issues.map((issue) => {
              const diagnostic = new vscode.Diagnostic(
                new vscode.Range(
                  document.positionAt(issue.offset),
                  document.positionAt(issue.offset + issue.length),
                ),
                issue.message,
                issue.severity === 'error'
                  ? vscode.DiagnosticSeverity.Error
                  : vscode.DiagnosticSeverity.Warning,
              )
              diagnostic.source = 'GridKit'
              return diagnostic
            }),
          )
          this.changed.fire(uri)
          return summary
        },
        (error) => {
          if (!controller.signal.aborted && document.version === version) {
            current.stale = true
            current.error = error.message
            current.diagnosticsVersion = version
            this.diagnostics.set(document.uri, [
              new vscode.Diagnostic(
                new vscode.Range(
                  document.positionAt(error.offset ?? 0),
                  document.positionAt((error.offset ?? 0) + (error.length ?? 1)),
                ),
                error.message,
              ),
            ])
            this.changed.fire(uri)
          }
          // The diagnostic shows why; whoever awaited this need not say it again.
          throw Object.assign(error, { diagnosed: true })
        },
      )
      .finally(() => {
        if (current.pending === pending) current.pending = undefined
      })
    entry.pending = pending
    return pending
  }
  edit(uri: string, expected: number, element: Element & { field: string }, value: Value) {
    return this.transact(
      uri,
      expected,
      [{ kind: 'set', id: element.id, field: element.field, value }],
      'Edit ' + element.field,
    )
  }
  /** Apply `mutations` as one workspace edit, queued behind the document's other edits and
   *  checked against revision `expected`. */
  transact(
    uri: string,
    expected: number,
    mutations: readonly Mutation[],
    label = 'Edit GridKit case',
  ): Promise<void> {
    const entry = this.entries.get(uri)
    if (!entry) return Promise.reject(new Error('The case document is closed.'))
    const check = () => {
      if (entry.document.isClosed || this.entries.get(uri) !== entry)
        throw new Error('The case document is closed.')
      if (entry.document.version !== expected || entry.stale)
        throw new Error('The document changed. Refresh before editing.')
      if (!isWritable(entry.document)) throw new Error('This document is read-only.')
    }
    const pending = (entry.editing ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        check()
        const edits = await this.client.call('transact', { uri, version: expected, mutations })
        check()
        if (!edits.length) return
        const workspaceEdit = new vscode.WorkspaceEdit()
        workspaceEdit.set(
          entry.document.uri,
          edits.map((change): [vscode.TextEdit, vscode.WorkspaceEditEntryMetadata] => [
            vscode.TextEdit.replace(
              new vscode.Range(
                entry.document.positionAt(change.offset),
                entry.document.positionAt(change.offset + change.length),
              ),
              change.text,
            ),
            { label, needsConfirmation: false },
          ]),
        )
        if (!(await vscode.workspace.applyEdit(workspaceEdit)))
          throw new Error('VS Code could not apply the document transaction.')
      })
      .finally(() => {
        if (entry.editing === pending) entry.editing = undefined
      })
    entry.editing = pending
    return pending
  }
  async reveal(uri: string, element?: Element) {
    const document =
      this.entries.get(uri)?.document ??
      (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)))
    const source = element
      ? await this.client.call('locate', {
          uri,
          version: (await this.ensure(document)).version,
          ...element,
        })
      : { offset: 0, length: 0 }
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    })
    editor.selection = new vscode.Selection(
      document.positionAt(source.offset),
      document.positionAt(source.offset + source.length),
    )
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }
  dispose() {
    for (const entry of this.entries.values()) {
      entry.controller?.abort()
      clearTimeout(entry.timer)
    }
    for (const disposable of this.disposables) disposable.dispose()
    this.changed.dispose()
    this.diagnostics.dispose()
  }
}
