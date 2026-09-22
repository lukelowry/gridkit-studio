import type { ElementRef } from '@latkit/model'
import * as vscode from 'vscode'

import { describe } from './errors.js'
import { type ParsedCase } from './gridkit/parse.js'
import { parseSolver, SolverError } from './gridkit/solver.js'
import { type Issue, locate, type Span } from './gridkit/source.js'
import { type CaseParser, type ParsedDocument, Parser } from './parser/client.js'

export type Snapshot = { version: number } & (
  | { state: 'pending' }
  | { state: 'valid'; case: ParsedCase }
  | { state: 'invalid'; issues: readonly Issue[] }
)

type Entry = {
  snapshot: Snapshot
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
  promise?: Promise<Exclude<Snapshot, { state: 'pending' }>>
  parsed?: Extract<ParsedDocument, { state: 'valid' }>
}
export const isCase = (uri: vscode.Uri): boolean => /\.case\.json$/i.test(uri.path)

export class Documents implements vscode.Disposable {
  private readonly entries = new Map<vscode.TextDocument, Entry>()
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('gridkit')
  private readonly changed = new vscode.EventEmitter<{
    document: vscode.TextDocument
    snapshot: Snapshot
  }>()
  readonly onDidChange = this.changed.event
  private readonly subscriptions: vscode.Disposable[]

  private readonly parser: CaseParser
  private disposed = false
  constructor(parser?: CaseParser) {
    this.parser = parser ?? new Parser((error) => this.failed(error))
    this.subscriptions = [
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.check(document)
      }),
      vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        if (contentChanges.length === 0) return
        if (!isCase(document.uri)) {
          this.check(document)
          return
        }
        const entry = this.entry(document)
        clearTimeout(entry.timer)
        entry.controller?.abort()
        entry.promise = undefined
        entry.snapshot = { version: document.version, state: 'pending' }
        this.diagnostics.delete(document.uri)
        this.changed.fire({ document, snapshot: entry.snapshot })
        entry.timer = setTimeout(() => {
          if (this.entries.get(document) === entry && !document.isClosed) this.schedule(document)
        }, 150)
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const entry = this.entries.get(document)
        clearTimeout(entry?.timer)
        entry?.controller?.abort()
        entry?.parsed?.dispose()
        this.entries.delete(document)
        this.diagnostics.delete(document.uri)
      }),
    ]
    for (const document of vscode.workspace.textDocuments) this.check(document)
  }

  private check(document: vscode.TextDocument): void {
    if (document.isClosed) return
    if (isCase(document.uri)) {
      this.schedule(document)
      return
    }
    if (!/\.solver\.json$/i.test(document.uri.path)) return
    const text = document.getText()
    const diagnostics: vscode.Diagnostic[] = []
    try {
      parseSolver(JSON.parse(text))
    } catch (error) {
      const span =
        error instanceof SolverError ? locate(text, error.path) : { offset: 0, length: 1 }
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
          document.positionAt(span.offset),
          document.positionAt(span.offset + span.length),
        ),
        describe(error),
        vscode.DiagnosticSeverity.Error,
      )
      diagnostic.source = 'GridKit'
      diagnostics.push(diagnostic)
    }
    this.diagnostics.set(document.uri, diagnostics)
  }

  private entry(document: vscode.TextDocument): Entry {
    let entry = this.entries.get(document)
    if (!entry) {
      entry = { snapshot: { version: document.version, state: 'pending' } }
      this.entries.set(document, entry)
    }
    return entry
  }

  current(document: vscode.TextDocument): Snapshot {
    const entry = this.entry(document)
    if (!entry.promise && !entry.timer && entry.snapshot.state === 'pending')
      this.schedule(document)
    return entry.snapshot
  }
  private schedule(document: vscode.TextDocument) {
    void this.ensureParsed(document).catch(() => {})
  }
  async ensureParsed(
    document: vscode.TextDocument,
    version = document.version,
    signal?: AbortSignal,
  ): Promise<Exclude<Snapshot, { state: 'pending' }>> {
    signal?.throwIfAborted()
    if (this.disposed || document.isClosed) throw new Error('The case document is closed.')
    if (document.version !== version) throw new Error('The case changed while it was being parsed.')
    const entry = this.entry(document)
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.snapshot.version === version && entry.snapshot.state !== 'pending')
      return entry.snapshot
    if (entry.snapshot.version !== version) {
      entry.controller?.abort()
      entry.promise = undefined
      entry.snapshot = { version, state: 'pending' }
      this.diagnostics.delete(document.uri)
      this.changed.fire({ document, snapshot: entry.snapshot })
    }
    if (!entry.promise) {
      const controller = (entry.controller = new AbortController())
      const text = document.getText()
      entry.promise = (async () => {
        let parsed: ParsedDocument
        try {
          parsed = await this.parser.parse(text, controller.signal)
        } catch (error) {
          controller.signal.throwIfAborted()
          parsed = {
            state: 'invalid',
            issues: [{ offset: 0, length: 0, message: describe(error) }],
          }
        }
        if (
          controller.signal.aborted ||
          this.disposed ||
          document.isClosed ||
          document.version !== version ||
          this.entries.get(document) !== entry
        ) {
          if (parsed.state === 'valid') parsed.dispose()
          throw new Error('The case changed while it was being parsed.')
        }
        const snapshot =
          parsed.state === 'valid'
            ? { version, state: 'valid' as const, case: parsed.case }
            : { version, state: 'invalid' as const, issues: parsed.issues }
        const previous = entry.parsed
        entry.parsed = parsed.state === 'valid' ? parsed : undefined
        this.publish(document, entry, snapshot)
        previous?.dispose()
        return snapshot
      })()
    }
    if (!signal) return entry.promise
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      entry.promise!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  private publish(
    document: vscode.TextDocument,
    entry: Entry,
    snapshot: Exclude<Snapshot, { state: 'pending' }>,
  ) {
    entry.snapshot = snapshot
    const issues: readonly Issue[] = snapshot.state === 'invalid' ? snapshot.issues : []
    this.diagnostics.set(
      document.uri,
      issues
        .filter((issue) => !issue.syntax || document.languageId !== 'json')
        .map((issue) => {
          const range = new vscode.Range(
            document.positionAt(issue.offset),
            document.positionAt(issue.offset + issue.length),
          )
          const diagnostic = new vscode.Diagnostic(
            range,
            issue.message,
            vscode.DiagnosticSeverity.Error,
          )
          diagnostic.source = 'GridKit'
          return diagnostic
        }),
    )
    this.changed.fire({ document, snapshot })
  }

  async source(document: vscode.TextDocument, ref: ElementRef): Promise<Span | undefined> {
    const snapshot = await this.ensureParsed(document)
    if (snapshot.state !== 'valid') return
    const entry = this.entries.get(document)!
    const span = await entry.parsed?.source(ref)
    if (document.isClosed || document.version !== snapshot.version)
      throw new Error('The case changed while locating its source.')
    return span
  }

  private failed(error: Error) {
    for (const [document, entry] of this.entries) {
      clearTimeout(entry.timer)
      entry.controller?.abort()
      entry.promise = undefined
      entry.parsed?.dispose()
      entry.parsed = undefined
      if (!document.isClosed)
        this.publish(document, entry, {
          version: document.version,
          state: 'invalid',
          issues: [{ offset: 0, length: 0, message: error.message }],
        })
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer)
      entry.controller?.abort()
      entry.parsed?.dispose()
    }
    this.parser.dispose()
    this.entries.clear()
    for (const disposable of this.subscriptions) disposable.dispose()
    this.diagnostics.dispose()
    this.changed.dispose()
  }
}
