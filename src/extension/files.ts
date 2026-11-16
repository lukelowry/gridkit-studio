/** The open case files. The worker reads each one whole, again whenever it changes on disk, and
 *  Problems lists its issues. Studio never writes a case. */

import * as vscode from 'vscode'

import { nameOf } from '../platform/path.js'
import { failedWith, type Problem, quiet, superseded } from '../shared/errors.js'
import { type Element, revisionOf, type SourceRange, type Summary } from '../shared/messages.js'
import type { Client } from './client.js'
import { diagnosed, isDiagnosed, notice, SHOW_PROBLEMS } from './report.js'

/** How long a changed file must stay unchanged before it is read again, so a save written in parts
 *  or a checkout of many files reads once. */
const SETTLE_MS = 100

const editorRange = ({ start, end }: SourceRange) =>
  new vscode.Range(start[0], start[1], end[0], end[1])

/** A case file's last summary, whether the file changed since, and why it failed to read. */
interface CaseFile {
  readonly summary?: Summary
  readonly stale: boolean
  readonly error?: string
}

interface Entry extends CaseFile {
  summary?: Summary
  stale: boolean
  error?: string
  /** The read in progress, dropped when the file changes. */
  pending?: Promise<Summary>
  reading?: AbortController
  /** The version whose issues Problems lists, and the validation in progress. */
  checked?: number
  checking?: AbortController
  /** Set when the worker crashed while reading this file: the file is not read again until it
   *  changes or Reload View runs. */
  failed?: Error
  /** Waiting for a changed file to settle; reads requested meanwhile wait for it. */
  settling?: { readonly settled: Promise<void>; settle(): void }
  timer?: ReturnType<typeof setTimeout>
  readonly watcher: vscode.Disposable
}

export class CaseFiles implements vscode.Disposable {
  readonly #entries = new Map<string, Entry>()
  /** Each read gets a new version. The worker answers with the version at which it first saw the
   *  current content, so rewriting a file unchanged changes nothing. */
  #version = 0
  readonly changed = new vscode.EventEmitter<string>()
  readonly diagnostics = vscode.languages.createDiagnosticCollection('gridkit')

  /** `report` shows read failures that Problems cannot place. */
  constructor(
    readonly client: Client,
    private readonly report: (error: unknown) => void,
  ) {}

  get(uri: string): CaseFile | undefined {
    return this.#entries.get(uri)
  }

  open(uri: string): void {
    if (this.#entries.has(uri)) return
    const file = vscode.Uri.parse(uri)
    // Watch the folder: the file name as a glob may match other files, or miss itself (`[`, `{`).
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(file, '..'), '*'),
    )
    const onlyThisFile =
      (then: () => void) =>
      ({ path }: vscode.Uri) => {
        if (path === file.path) then()
      }
    this.#entries.set(uri, {
      stale: true,
      watcher: vscode.Disposable.from(
        watcher,
        watcher.onDidChange(onlyThisFile(() => this.#changed(uri))),
        watcher.onDidCreate(onlyThisFile(() => this.#changed(uri))),
        watcher.onDidDelete(onlyThisFile(() => this.#gone(uri))),
      ),
    })
    void this.read(uri).catch(() => {})
  }

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

  /** The current summary of the case at `uri`, read again only if the file changed. Throws why it
   *  does not read, with diagnostics in Problems when it can place them. A superseded read resolves
   *  with the newer one. */
  async read(uri: string): Promise<Summary> {
    for (;;) {
      const entry = this.#entries.get(uri)
      if (!entry) throw new Error('This case is not open in GridKit Studio.')
      if (entry.failed) throw entry.failed
      if (entry.settling) {
        await entry.settling.settled
        continue
      }
      try {
        return await (entry.pending ?? this.#read(uri, entry))
      } catch (error) {
        if (!failedWith(error, 'superseded')) throw error
      }
    }
  }

  /** Like `read`, for a user action. A case with diagnostics throws a notice to fix them `before`
   *  the action. */
  async readable(uri: string, before?: string): Promise<Summary> {
    try {
      return await this.read(uri)
    } catch (error) {
      if (!isDiagnosed(error)) throw error
      throw notice(
        `${nameOf(uri)} has problems to fix ${before ? 'before ' + before : 'first'}.`,
        SHOW_PROBLEMS,
      )
    }
  }

  async reveal(uri: string, element?: Element): Promise<void> {
    const selection =
      element &&
      editorRange(
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

  /** The worker stopped with `error`. The new worker reads every file again, except those being
   *  read during the crash, which wait for a change or Reload View. */
  restart(error: Error): void {
    for (const [uri, entry] of this.#entries) {
      const failed = entry.pending
        ? new Error(`${error.message} Save ${nameOf(uri)} or run Reload View to read it again.`)
        : undefined
      this.#stop(entry)
      Object.assign(entry, { checked: undefined, stale: true, error: error.message, failed })
      this.changed.fire(uri)
      if (!failed) void this.read(uri).catch(() => {})
    }
  }

  /** Reload View: reads a file that was being read when the worker crashed. */
  retry(uri: string): void {
    const entry = this.#entries.get(uri)
    if (!entry?.failed) return
    entry.failed = undefined
    void this.read(uri).catch(() => {})
  }

  #stop(entry: Entry): void {
    entry.reading?.abort()
    entry.checking?.abort()
    entry.pending = undefined
    this.#endSettling(entry)
  }

  /** Ends `entry`'s settle wait and releases reads waiting on it. */
  #endSettling(entry: Entry): void {
    clearTimeout(entry.timer)
    entry.settling?.settle()
    entry.settling = undefined
  }

  /** The file changed on disk: mark it stale and read it once it settles. */
  #changed(uri: string): void {
    const entry = this.#entries.get(uri)
    if (!entry) return
    entry.reading?.abort()
    entry.pending = undefined
    entry.failed = undefined
    clearTimeout(entry.timer)
    if (!entry.settling) {
      let settle!: () => void
      const settled = new Promise<void>((resolve) => (settle = resolve))
      entry.settling = { settled, settle }
    }
    entry.timer = setTimeout(() => {
      this.#endSettling(entry)
      void this.read(uri).catch(() => {})
    }, SETTLE_MS)
    if (entry.stale) return
    entry.stale = true
    this.changed.fire(uri)
  }

  /** The file was deleted: keep the last summary, marked stale, until it reappears. */
  #gone(uri: string): void {
    const entry = this.#entries.get(uri)
    if (!entry) return
    this.#stop(entry)
    Object.assign(entry, { stale: true, error: 'The case file is not there.' })
    this.changed.fire(uri)
  }

  #read(uri: string, entry: Entry): Promise<Summary> {
    this.#endSettling(entry)
    const reading = (entry.reading = new AbortController())
    const current = () => this.#entries.get(uri) === entry && !reading.signal.aborted
    const pending: Promise<Summary> = this.client.worker
      .call('read', { uri, version: ++this.#version }, reading.signal)
      .then(
        (read) => {
          if (!current()) throw superseded()
          // Unchanged content keeps its summary object, so the views fetch nothing again.
          const summary = read.version === entry.summary?.version ? entry.summary : read
          const updated = summary !== entry.summary || entry.stale || entry.error !== undefined
          Object.assign(entry, { summary, stale: false, error: undefined })
          // Clear diagnostics from another version or a failed read right away.
          if (entry.checked !== summary.version) {
            this.diagnostics.delete(vscode.Uri.parse(uri))
            this.#check(uri, entry, summary)
          }
          if (updated) this.changed.fire(uri)
          return summary
        },
        (error: Error & Pick<Problem, 'range' | 'problems'>) => {
          if (!current()) throw superseded()
          entry.checking?.abort()
          Object.assign(entry, { stale: true, error: error.message, checked: undefined })
          // Problems shows errors that have a location; anything else is reported.
          const places = error.problems?.length
            ? error.problems
            : error.range
              ? [{ message: error.message, range: error.range }]
              : []
          if (places.length) {
            this.diagnostics.set(
              vscode.Uri.parse(uri),
              places.map(
                ({ message, range }) => new vscode.Diagnostic(editorRange(range), message),
              ),
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

  /** Lists the case's validation issues in Problems, once per version. */
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
                editorRange(issue),
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
