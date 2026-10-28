import * as vscode from 'vscode'

import { defect, failedWith, superseded } from '../shared/errors.js'
import {
  type Element,
  type Mutation,
  revisionOf,
  type SourceDelta,
  type SourceEdit,
  type SourceRange,
  type Summary,
  type Value,
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

/** How long `document`'s text is, without copying it. */
const lengthOf = (document: vscode.TextDocument) =>
  document.offsetAt(document.lineAt(document.lineCount - 1).range.end)

/** `document`'s whole text, which must be its text at `version`: one sent under another version
 *  would be read as that version's. */
export function wholeAt(document: vscode.TextDocument, version: number): { text: string } {
  if (document.version !== version) throw superseded()
  return { text: document.getText() }
}

/** What `read` makes of `document`, read again for as long as a newer version of it takes the
 *  place of the one read meanwhile. */
export async function current<T>(
  document: vscode.TextDocument,
  read: () => Promise<T>,
): Promise<T> {
  for (;;)
    try {
      return await read()
    } catch (error) {
      if (!failedWith(error, 'superseded') || document.isClosed) throw error
    }
}

/** Whether `error` says what is wrong with a case's source, rather than why Studio could not read
 *  it. */
const inSource = (error: unknown) =>
  !defect(error) && (failedWith(error, 'invalid-input') || failedWith(error, 'limit'))

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
  /** `report` says why a case could not be read where Problems does not. */
  constructor(
    readonly client: Client,
    private readonly report: (error: unknown) => void,
  ) {
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

  /** The case `document` reads as now, through every read a newer one replaces while it is read;
   *  why it does not read, thrown. */
  read(document: vscode.TextDocument): Promise<Summary> {
    return current(document, () => this.ensure(document))
  }

  /** The case `document` reads as now, or undefined when it does not: Problems, or the
   *  notification of why the case worker stopped, says why. */
  parsed(document: vscode.TextDocument): Promise<Summary | undefined> {
    return this.read(document).catch(() => undefined)
  }

  /** A new case worker reads the open cases again, unless the reading may be what stops it: then
   *  each waits until it changes or opens again, and asked of meanwhile, says why. Returns why, to
   *  say once. */
  restart(error: Error): Error {
    const retry = this.client.cases.steady
    const why = new Error(
      `${error.message} It stopped ${CRASHES} times in a minute, so Studio reads each case ` +
        'again once you edit or reopen it.',
    )
    for (const [uri, entry] of this.#entries) {
      entry.controller?.abort()
      clearTimeout(entry.timer)
      entry.stale = true
      entry.error = error.message
      entry.failed = retry ? undefined : { version: entry.document.version, reason: why }
      entry.workerVersion = undefined
      entry.changes = []
      entry.pending = undefined
      this.changed.fire(uri)
      if (retry) void this.parse(entry.document).catch(() => {})
    }
    return retry ? error : why
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
   *  version the worker holds, with the length of the text they make, which the worker checks; or,
   *  before it holds one, the whole text. Unless `peek`, the worker is taken to hold it once sent. */
  #delta(entry: Entry, document: vscode.TextDocument, peek = false): SourceDelta {
    const delta: SourceDelta =
      entry.workerVersion !== undefined
        ? {
            baseVersion: entry.workerVersion,
            changes: [...entry.changes],
            length: lengthOf(document),
          }
        : { text: document.getText() }
    if (!peek) {
      entry.changes = []
      entry.workerVersion = document.version
    }
    return delta
  }

  /** The fields that complete at `offset` of `document`. Only what changed since the case worker's
   *  copy crosses, the worker reads no further than the cursor, and the copy stays as it was: a
   *  completion let go of, as one is at each keystroke, leaves the edits for the next read. */
  complete(document: vscode.TextDocument, offset: number, signal: AbortSignal) {
    const entry = this.#entry(document)
    const version = document.version
    const revision = { uri: document.uri.toString(), version, attachmentId: entry.attachmentId }
    return resent(
      (source: SourceDelta) =>
        this.client.cases.call('complete', { ...revision, offset, ...source }, signal),
      'stale-source',
      this.#delta(entry, document, true),
      () => wholeAt(document, version),
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
    const pending = resent(
      (source: SourceDelta) =>
        this.client.cases.call('parse', { ...revision, ...source }, controller.signal),
      'stale-source',
      this.#delta(entry, document),
      () => wholeAt(document, version),
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
              this.report(error)
            }
          })
          return summary
        },
        (error) => {
          // A read a newer one replaced failed nothing.
          if (controller.signal.aborted || document.version !== version) throw error
          // What is wrong with the source Problems says, where it can; any other failure is said.
          const wrong = inSource(error)
          const reason = wrong ? diagnosed(error) : error
          current.stale = true
          current.error = error.message
          current.failed = { version, reason }
          if (wrong)
            this.diagnostics.set(document.uri, [
              new vscode.Diagnostic(
                rangeOf(document, { offset: error.offset ?? 0, length: error.length ?? 1 }),
                error.message,
              ),
            ])
          else this.report(reason)
          this.changed.fire(uri)
          throw reason
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
      .call('validate', revisionOf(summary), signal)
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
      [{ kind: 'set', entity: element, field: element.field, value }],
      'Edit ' + element.field,
    )
  }

  /** Apply `mutations` as one workspace edit, queued behind the document's other edits and
   *  checked against revision `expected`, of the document `attachmentId` names when given: or, for
   *  mutations no revision changes the meaning of, as what the elements record, against the
   *  latest. */
  transact(
    uri: string,
    expected: number | 'latest',
    mutations: readonly Mutation[],
    label = 'Edit GridKit case',
    attachmentId?: string,
  ): Promise<void> {
    const entry = this.#entries.get(uri)
    if (!entry) return Promise.reject(closedDocument())
    const check = (version: number) => {
      if (entry.document.isClosed || this.#entries.get(uri) !== entry) throw closedDocument()
      if (
        entry.document.version !== version ||
        entry.stale ||
        (attachmentId !== undefined && entry.attachmentId !== attachmentId)
      )
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
    const read = element && (await this.read(document))
    const source = read
      ? await this.client.cases.call('locate', {
          uri,
          version: read.version,
          attachmentId: read.attachmentId,
          ...element!,
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
