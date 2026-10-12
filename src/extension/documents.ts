import * as vscode from 'vscode'

import type { Value } from '../shared/messages.js'
import type { Element, Mutation, SourceDelta, SourceEdit, Summary } from '../shared/messages.js'
import type { Client } from './client.js'

/** Whether `document` can be edited; a file system VS Code does not know counts as writable. */
export function isWritable(document: vscode.TextDocument) {
  return vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) !== false
}

interface Entry {
  attachmentId: string
  document: vscode.TextDocument
  summary?: Summary
  pending?: Promise<Summary>
  validation?: Promise<Summary>
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  /** The version the worker's source mirror holds. */
  workerVersion?: number
  /** Edits since `workerVersion`, sent as a delta on the next parse. */
  changes: SourceEdit[][]
  editing?: Promise<void>
  stale: boolean
  error?: string
  /** The version that failed to read, and why: it is not read again until it changes. */
  failed?: { version: number; reason: Error }
}
/** A worker that stops this many times within `CRASH_MS` has the cases read again only once one of
 *  them changes or opens again, so a case it cannot read does not stop it over and over. */
const CRASHES = 3
const CRASH_MS = 60_000

/** Why a read failed, which its diagnostic says already: whoever awaited it need not say it. */
const diagnosed = (reason: Error) => Object.assign(reason, { diagnosed: true })

/** Whether the case worker's copy of a document was not at the base of the changes it was sent. */
const stale = (error: unknown) => (error as { code?: unknown } | null)?.code === 'stale-source'

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
        if (!entry || entry.document !== document) return
        entry.controller?.abort()
        clearTimeout(entry.timer)
        this.entries.delete(uri)
        this.changed.fire(uri)
        this.diagnostics.delete(document.uri)
        void this.client.cases
          .call('release', { uri, attachmentId: entry.attachmentId })
          .catch(() => {})
      }),
    ]
  }
  /** A new case worker reads the open cases again, unless the reading may be what stops it: then
   *  each waits until it changes or opens again. Returns why, to say once. */
  restart(error: Error): Error {
    const now = Date.now()
    this.#crashes = [...this.#crashes.filter((time) => now - time < CRASH_MS), now]
    const retry = this.#crashes.length < CRASHES
    for (const [uri, entry] of this.entries) {
      entry.controller?.abort()
      clearTimeout(entry.timer)
      entry.stale = true
      entry.error = error.message
      entry.failed = retry
        ? undefined
        : { version: entry.document.version, reason: diagnosed(new Error(error.message)) }
      entry.workerVersion = undefined
      entry.changes = []
      entry.pending = undefined
      this.changed.fire(uri)
      if (retry) void this.parse(entry.document).catch(() => {})
    }
    return retry
      ? error
      : new Error(
          `${error.message} It stopped ${CRASHES} times in a minute, so Studio reads each case ` +
            'again once you edit or reopen it.',
        )
  }
  async ensure(document: vscode.TextDocument): Promise<Summary> {
    const entry = this.entries.get(document.uri.toString())
    if (entry?.summary?.version === document.version && !entry.stale) return entry.summary
    if (entry?.pending) return entry.pending
    // A version that failed to read fails again without another read: Problems says why.
    if (entry?.failed?.version === document.version) throw entry.failed.reason
    return this.parse(document)
  }
  /** `document`'s entry, made on first use. */
  #entry(document: vscode.TextDocument): Entry {
    const uri = document.uri.toString()
    let entry = this.entries.get(uri)
    if (!entry) {
      entry = { document, attachmentId: crypto.randomUUID(), stale: true, changes: [] }
      this.entries.set(uri, entry)
    }
    return entry
  }
  /** What brings the case worker's copy of `document` to its version: the changes since the
   *  version the worker holds, or, before it holds one, the whole text. */
  #delta(entry: Entry, document: vscode.TextDocument): SourceDelta {
    const delta: SourceDelta =
      entry.workerVersion !== undefined
        ? { baseVersion: entry.workerVersion, changes: entry.changes }
        : { text: document.getText() }
    entry.changes = []
    entry.workerVersion = document.version
    return delta
  }
  /** The fields that complete at `offset` of `document`. Only what changed since the case worker's
   *  copy crosses, and the worker reads no further than the cursor. */
  complete(document: vscode.TextDocument, offset: number, signal: AbortSignal) {
    const entry = this.#entry(document)
    const uri = document.uri.toString()
    const version = document.version
    const call = (source: SourceDelta) =>
      this.client.cases.call(
        'complete',
        { uri, version, attachmentId: entry.attachmentId, offset, ...source },
        signal,
      )
    return call(this.#delta(entry, document)).catch((error: Error) => {
      // The worker's copy is not at the delta's base: send the whole text.
      if (stale(error) && !signal.aborted) return call({ text: document.getText() })
      throw error
    })
  }
  parse(document: vscode.TextDocument): Promise<Summary> {
    const uri = document.uri.toString()
    const entry = this.#entry(document)
    entry.controller?.abort()
    entry.validation = undefined
    clearTimeout(entry.timer)
    const controller = (entry.controller = new AbortController())
    const version = document.version
    const current = entry
    const input = {
      uri,
      version,
      attachmentId: entry.attachmentId,
      ...this.#delta(entry, document),
    }
    const pending = this.client.cases
      .call('parse', input, controller.signal)
      .catch((error) => {
        // The worker's mirror is not at the delta's base: resend the whole text.
        if (stale(error) && !controller.signal.aborted && document.version === version)
          return this.client.cases.call(
            'parse',
            { uri, version, attachmentId: current.attachmentId, text: document.getText() },
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
          current.failed = undefined
          this.diagnostics.delete(document.uri)
          this.changed.fire(uri)
          // The view can request topology immediately. Diagnostics decode remaining columns
          // cooperatively and share this document revision's cancellation signal.
          void this.validate(document).catch((error) => {
            if (!controller.signal.aborted && this.entries.get(uri) === current) {
              current.error = error.message
              this.changed.fire(uri)
            }
          })
          return summary
        },
        (error) => {
          if (!controller.signal.aborted && document.version === version) {
            current.stale = true
            current.error = error.message
            current.failed = { version, reason: diagnosed(error) }
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
          throw diagnosed(error)
        },
      )
      .finally(() => {
        if (current.pending === pending) current.pending = undefined
      })
    entry.pending = pending
    return pending
  }
  async validate(document: vscode.TextDocument): Promise<Summary> {
    const summary = await this.ensure(document)
    const uri = document.uri.toString()
    const entry = this.entries.get(uri)
    if (!entry || entry.stale || entry.summary !== summary || document.version !== summary.version)
      throw new Error('Superseded revision')
    if (summary.validation === 'complete') return summary
    if (entry.validation) return entry.validation
    const signal = entry.controller!.signal
    const pending = this.client.cases
      .call('validate', { uri, version: summary.version, attachmentId: entry.attachmentId }, signal)
      .then((issues) => {
        signal.throwIfAborted()
        if (this.entries.get(uri) !== entry || document.version !== summary.version)
          throw new Error('Superseded revision')
        const validated: Summary = { ...summary, issues, validation: 'complete' }
        entry.summary = validated
        this.diagnostics.set(
          document.uri,
          issues.map((issue) => {
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
        return validated
      })
      .finally(() => {
        if (entry.validation === pending) entry.validation = undefined
      })
    entry.validation = pending
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
   *  checked against revision `expected`: or, for mutations no revision changes the meaning of, as
   *  what the elements record, against the latest. */
  transact(
    uri: string,
    expected: number | 'latest',
    mutations: readonly Mutation[],
    label = 'Edit GridKit case',
  ): Promise<void> {
    const entry = this.entries.get(uri)
    if (!entry) return Promise.reject(new Error('The case document is closed.'))
    const check = (version: number) => {
      if (entry.document.isClosed || this.entries.get(uri) !== entry)
        throw new Error('The case document is closed.')
      if (entry.document.version !== version || entry.stale)
        throw new Error('The document changed. Refresh before editing.')
      if (!isWritable(entry.document)) throw new Error('This document is read-only.')
    }
    const pending = (entry.editing ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const version =
          expected === 'latest' ? (await this.ensure(entry.document)).version : expected
        check(version)
        const edits = await this.client.cases.call('transact', {
          uri,
          version,
          attachmentId: entry.attachmentId,
          mutations,
        })
        check(version)
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
      ? await this.client.cases.call('locate', {
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
