import * as vscode from 'vscode'

import { superseded } from '../shared/errors.js'
import type {
  Element,
  Mutation,
  SourceDelta,
  SourceEdit,
  SourceRange,
  Summary,
  Value,
} from '../shared/messages.js'
import { resent } from '../shared/rpc.js'
import { type Client, CRASHES } from './client.js'
import { diagnosed } from './report.js'

/** Whether `document` can be edited; a file system VS Code does not know counts as writable. */
export function isWritable(document: vscode.TextDocument) {
  return vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) !== false
}

/** Where `range` lies in `document`. */
export const rangeOf = (document: vscode.TextDocument, { offset, length }: SourceRange) =>
  new vscode.Range(document.positionAt(offset), document.positionAt(offset + length))

/** An open case document as Studio reads it: its last summary, and whether it is behind its
 *  document, and why its revision does not read. */
export interface CaseDocument {
  readonly document: vscode.TextDocument
  readonly summary?: Summary
  readonly stale: boolean
  readonly error?: string
}

interface Entry extends CaseDocument {
  attachmentId: string
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
/** How long typing rests before the case is read again. */
const EDIT_MS = 150

/** Why a document VS Code closed reads no more. */
const closedDocument = () => new Error('The case document is closed.')

export class Documents implements vscode.Disposable {
  readonly #entries = new Map<string, Entry>()
  readonly changed = new vscode.EventEmitter<string>()
  /** Fire as Studio begins to read a case document, and once VS Code closes it. */
  readonly opened = new vscode.EventEmitter<string>()
  readonly closed = new vscode.EventEmitter<string>()
  readonly diagnostics = vscode.languages.createDiagnosticCollection('gridkit')
  readonly #disposables: vscode.Disposable[]
  constructor(readonly client: Client) {
    this.#disposables = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        const entry = this.#entries.get(event.document.uri.toString())
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
        }, EDIT_MS)
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const uri = document.uri.toString()
        const entry = this.#entries.get(uri)
        if (!entry || entry.document !== document) return
        entry.controller?.abort()
        clearTimeout(entry.timer)
        this.#entries.delete(uri)
        this.diagnostics.delete(document.uri)
        void this.client.cases
          .call('release', { uri, attachmentId: entry.attachmentId })
          .catch(() => {})
        this.changed.fire(uri)
        this.closed.fire(uri)
      }),
    ]
  }

  /** The case document at `uri`, while Studio reads it. */
  get(uri: string): CaseDocument | undefined {
    return this.#entries.get(uri)
  }

  /** The case `document` reads as, or undefined when it does not: Problems says why. */
  parsed(document: vscode.TextDocument): Promise<Summary | undefined> {
    return this.ensure(document).catch(() => undefined)
  }

  /** A new case worker reads the open cases again, unless the reading may be what stops it: then
   *  each waits until it changes or opens again. Returns why, to say once. */
  restart(error: Error): Error {
    const retry = this.client.cases.steady
    for (const [uri, entry] of this.#entries) {
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
    const entry = this.#entries.get(document.uri.toString())
    if (entry?.summary?.version === document.version && !entry.stale) return entry.summary
    if (entry?.pending) return entry.pending
    // A version that failed to read fails again without another read: Problems says why.
    if (entry?.failed?.version === document.version) throw entry.failed.reason
    return this.parse(document)
  }

  /** `document`'s entry, made on first use; a document VS Code closed has none. */
  #entry(document: vscode.TextDocument): Entry {
    if (document.isClosed) throw closedDocument()
    const uri = document.uri.toString()
    let entry = this.#entries.get(uri)
    if (!entry) {
      entry = { document, attachmentId: crypto.randomUUID(), stale: true, changes: [] }
      this.#entries.set(uri, entry)
      this.opened.fire(uri)
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
    const revision = {
      uri: document.uri.toString(),
      version: document.version,
      attachmentId: entry.attachmentId,
      offset,
    }
    return resent(
      (source: SourceDelta) =>
        this.client.cases.call('complete', { ...revision, ...source }, signal),
      'stale-source',
      this.#delta(entry, document),
      () => ({ text: document.getText() }),
      signal,
    )
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
    const revision = { uri, version, attachmentId: entry.attachmentId }
    // A change since aborts the read, so the whole text is sent only for this version.
    const pending = resent(
      (source: SourceDelta) =>
        this.client.cases.call('parse', { ...revision, ...source }, controller.signal),
      'stale-source',
      this.#delta(entry, document),
      () => ({ text: document.getText() }),
      controller.signal,
    )
      .then(
        (summary) => {
          if (document.version !== version || controller.signal.aborted) throw superseded()
          current.summary = summary
          current.stale = false
          current.error = undefined
          current.failed = undefined
          this.diagnostics.delete(document.uri)
          this.changed.fire(uri)
          // The view can request topology immediately. Diagnostics decode remaining columns
          // cooperatively and share this document revision's cancellation signal.
          void this.validate(document).catch((error) => {
            if (!controller.signal.aborted && this.#entries.get(uri) === current) {
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
                rangeOf(document, { offset: error.offset ?? 0, length: error.length ?? 1 }),
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
    const entry = this.#entries.get(uri)
    if (!entry || entry.stale || entry.summary !== summary || document.version !== summary.version)
      throw superseded()
    if (summary.validation === 'complete') return summary
    if (entry.validation) return entry.validation
    const signal = entry.controller!.signal
    const pending = this.client.cases
      .call('validate', { uri, version: summary.version, attachmentId: entry.attachmentId }, signal)
      .then((issues) => {
        signal.throwIfAborted()
        if (this.#entries.get(uri) !== entry || document.version !== summary.version)
          throw superseded()
        const validated: Summary = { ...summary, issues, validation: 'complete' }
        entry.summary = validated
        this.diagnostics.set(
          document.uri,
          issues.map((issue) => {
            const diagnostic = new vscode.Diagnostic(
              rangeOf(document, issue),
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
    const entry = this.#entries.get(uri)
    if (!entry) return Promise.reject(closedDocument())
    const check = (version: number) => {
      if (entry.document.isClosed || this.#entries.get(uri) !== entry) throw closedDocument()
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
            vscode.TextEdit.replace(rangeOf(entry.document, change), change.text),
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
      this.#entries.get(uri)?.document ??
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
    const range = rangeOf(document, source)
    editor.selection = new vscode.Selection(range.start, range.end)
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  dispose() {
    for (const entry of this.#entries.values()) {
      entry.controller?.abort()
      clearTimeout(entry.timer)
    }
    for (const disposable of this.#disposables) disposable.dispose()
    this.changed.dispose()
    this.opened.dispose()
    this.closed.dispose()
    this.diagnostics.dispose()
  }
}
