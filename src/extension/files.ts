/** The case files Studio shows. The worker reads each one whole from disk, and again whenever
 *  it changes there, and Problems says what is wrong with it. Studio never writes a case. */

import * as vscode from 'vscode'

import { failedWith, type Problem, quiet, superseded } from '../shared/errors.js'
import { type Element, revisionOf, type SourceRange, type Summary } from '../shared/messages.js'
import type { Client } from './client.js'
import { diagnosed } from './report.js'

/** How long a file rests after it changes before it is read again, so a save written in parts, or
 *  a checkout of many files, reads once. */
const SETTLE_MS = 100

/** `range` as VS Code takes one. */
const rangeOf = ({ start, end }: SourceRange) =>
  new vscode.Range(start[0], start[1], end[0], end[1])

/** A case file as Studio reads it: its last summary, whether the file has moved past it, and why
 *  the file does not read. */
interface CaseFile {
  readonly summary?: Summary
  readonly stale: boolean
  readonly error?: string
}

interface Entry extends CaseFile {
  summary?: Summary
  stale: boolean
  error?: string
  /** The read under way, which a change of the file lets go of. */
  pending?: Promise<Summary>
  reading?: AbortController
  /** The version whose issues Problems lists, and the check of it under way. */
  checked?: number
  checking?: AbortController
  /** Why the file is not read until it changes: reading it may be what stopped the last worker. */
  failed?: Error
  timer?: ReturnType<typeof setTimeout>
  readonly watcher: vscode.Disposable
}

export class CaseFiles implements vscode.Disposable {
  readonly #entries = new Map<string, Entry>()
  /** Each read asks at a version of its own. The worker answers at the version the file's content
   *  was first read at, so a file written again as it was changes nothing. */
  #version = 0
  /** Fires when a file's summary changes, or whether the file has moved past it. */
  readonly changed = new vscode.EventEmitter<string>()
  readonly diagnostics = vscode.languages.createDiagnosticCollection('gridkit')

  /** `report` says why a file could not be read where Problems does not. */
  constructor(
    readonly client: Client,
    private readonly report: (error: unknown) => void,
  ) {}

  get(uri: string): CaseFile | undefined {
    return this.#entries.get(uri)
  }

  /** Follows the file at `uri`: reads it now, and again whenever it changes on disk. */
  open(uri: string): void {
    if (this.#entries.has(uri)) return
    const file = vscode.Uri.parse(uri)
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(file, '..'), file.path.split('/').at(-1)!),
    )
    const changed = () => this.#changed(uri)
    this.#entries.set(uri, {
      stale: true,
      watcher: vscode.Disposable.from(
        watcher,
        watcher.onDidChange(changed),
        watcher.onDidCreate(changed),
        watcher.onDidDelete(() => this.#gone(uri)),
      ),
    })
    void this.read(uri).catch(() => {})
  }

  /** Stops following the file at `uri`, and lets the worker go of its case. */
  close(uri: string): void {
    const entry = this.#entries.get(uri)
    if (!entry) return
    this.#entries.delete(uri)
    this.#stop(entry)
    entry.watcher.dispose()
    this.diagnostics.delete(vscode.Uri.parse(uri))
    if (this.client.worker.running) void this.client.worker.call('release', { uri }).catch(() => {})
    this.changed.fire(uri)
  }

  /** The case at `uri` as its file reads now, read again only if the file changed. Why it does not
   *  read, thrown: Problems says where, when it can. A read that a newer one takes the place of
   *  answers with the newer one. */
  async read(uri: string): Promise<Summary> {
    for (;;) {
      const entry = this.#entries.get(uri)
      if (!entry) throw new Error('GridKit Studio does not follow this case.')
      if (entry.failed) throw entry.failed
      try {
        return await (entry.pending ?? this.#read(uri, entry))
      } catch (error) {
        if (!failedWith(error, 'superseded')) throw error
      }
    }
  }

  /** Opens the file as text beside, with `element` selected there when one is given. */
  async reveal(uri: string, element?: Element): Promise<void> {
    const selection =
      element &&
      rangeOf(
        await this.client.worker.call('locate', {
          ...revisionOf(await this.read(uri)),
          ...element,
        }),
      )
    const options: vscode.TextDocumentShowOptions = {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
      ...(selection && { selection }),
    }
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.parse(uri),
      'default',
      options,
    )
  }

  /** The worker stopped with `error`: a new one reads every file again, unless reading one may be
   *  what stopped it, when `failed` says so, and each waits until its file changes. */
  restart(error: Error, failed?: Error): void {
    for (const [uri, entry] of this.#entries) {
      this.#stop(entry)
      Object.assign(entry, { checked: undefined, stale: true, error: error.message, failed })
      this.changed.fire(uri)
      if (!failed) void this.read(uri).catch(() => {})
    }
  }

  /** Lets go of what `entry` does now: its read, its check, and its wait to read again. */
  #stop(entry: Entry): void {
    entry.reading?.abort()
    entry.checking?.abort()
    entry.pending = undefined
    clearTimeout(entry.timer)
  }

  /** The file changed on disk: what was read of it is behind it until it rests and reads again. */
  #changed(uri: string): void {
    const entry = this.#entries.get(uri)
    if (!entry) return
    entry.reading?.abort()
    entry.pending = undefined
    entry.failed = undefined
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void this.read(uri).catch(() => {}), SETTLE_MS)
    if (entry.stale) return
    entry.stale = true
    this.changed.fire(uri)
  }

  /** The file is gone: what was read of it stands, behind, until a file is there again. */
  #gone(uri: string): void {
    const entry = this.#entries.get(uri)
    if (!entry) return
    this.#stop(entry)
    Object.assign(entry, { stale: true, error: 'The case file is not there.' })
    this.changed.fire(uri)
  }

  #read(uri: string, entry: Entry): Promise<Summary> {
    clearTimeout(entry.timer)
    const reading = (entry.reading = new AbortController())
    const current = () => this.#entries.get(uri) === entry && !reading.signal.aborted
    const pending: Promise<Summary> = this.client.worker
      .call('read', { uri, version: ++this.#version }, reading.signal)
      .then(
        (read) => {
          if (!current()) throw superseded()
          // The file as it was keeps its summary, so the views read nothing again.
          const summary = read.version === entry.summary?.version ? entry.summary : read
          const news = summary !== entry.summary || entry.stale || entry.error !== undefined
          Object.assign(entry, { summary, stale: false, error: undefined })
          // What Problems said of another version, or of a file that did not read, goes at once.
          if (entry.checked !== summary.version) {
            this.diagnostics.delete(vscode.Uri.parse(uri))
            this.#check(uri, entry, summary)
          }
          if (news) this.changed.fire(uri)
          return summary
        },
        (error: Error & Pick<Problem, 'range' | 'problems'>) => {
          if (!current()) throw superseded()
          entry.checking?.abort()
          Object.assign(entry, { stale: true, error: error.message, checked: undefined })
          // Problems says what is wrong in the file, where it says where; anything else is said.
          const places = error.problems?.length
            ? error.problems
            : error.range
              ? [{ message: error.message, range: error.range }]
              : []
          if (places.length) {
            this.diagnostics.set(
              vscode.Uri.parse(uri),
              places.map(({ message, range }) => new vscode.Diagnostic(rangeOf(range), message)),
            )
            diagnosed(error)
          } else this.report(error)
          this.changed.fire(uri)
          throw error
        },
      )
      .finally(() => {
        if (entry.pending === pending) entry.pending = undefined
      })
    entry.pending = pending
    return pending
  }

  /** Lists in Problems what is wrong with the case `summary` describes, once per version. */
  #check(uri: string, entry: Entry, summary: Summary): void {
    entry.checking?.abort()
    const checking = (entry.checking = new AbortController())
    entry.checked = summary.version
    void this.client.worker.call('validate', revisionOf(summary), checking.signal).then(
      (issues) => {
        if (checking.signal.aborted || this.#entries.get(uri) !== entry) return
        this.diagnostics.set(
          vscode.Uri.parse(uri),
          issues.map((issue) =>
            Object.assign(
              new vscode.Diagnostic(
                rangeOf(issue),
                issue.message,
                issue.severity === 'error'
                  ? vscode.DiagnosticSeverity.Error
                  : vscode.DiagnosticSeverity.Warning,
              ),
              { source: 'GridKit' },
            ),
          ),
        )
      },
      (error: unknown) => {
        if (entry.checking === checking) entry.checked = undefined
        if (!checking.signal.aborted && !quiet(error)) this.report(error)
      },
    )
  }

  dispose() {
    for (const entry of this.#entries.values()) {
      this.#stop(entry)
      entry.watcher.dispose()
    }
    this.#entries.clear()
    this.changed.dispose()
    this.diagnostics.dispose()
  }
}
