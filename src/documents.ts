import type { ElementRef } from '@latkit/model'
import * as vscode from 'vscode'

import { describe } from './errors.js'
import { parse, type ParsedCase } from './gridkit/parse.js'
import { parseSolver, SolverError } from './gridkit/solver.js'
import {
  elementKey,
  indexElements,
  type Issue,
  locate,
  type Span,
  syntaxIssues,
} from './gridkit/source.js'
import { CaseError } from './gridkit/validate.js'

export type Snapshot = { version: number } & (
  | { state: 'pending' }
  | { state: 'valid'; case: ParsedCase }
  | { state: 'invalid'; issues: readonly Issue[] }
)

type Entry = {
  snapshot: Snapshot
  timer?: ReturnType<typeof setTimeout>
  sources?: ReadonlyMap<string, Span>
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

  constructor() {
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
        entry.sources = undefined
        entry.snapshot = { version: document.version, state: 'pending' }
        this.diagnostics.delete(document.uri)
        this.changed.fire({ document, snapshot: entry.snapshot })
        entry.timer = setTimeout(() => {
          if (this.entries.get(document) === entry && !document.isClosed) this.read(document)
        }, 150)
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        clearTimeout(this.entries.get(document)?.timer)
        this.entries.delete(document)
        this.diagnostics.delete(document.uri)
      }),
    ]
    for (const document of vscode.workspace.textDocuments) this.check(document)
  }

  private check(document: vscode.TextDocument): void {
    if (document.isClosed) return
    if (isCase(document.uri)) {
      this.read(document)
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

  read(document: vscode.TextDocument): Exclude<Snapshot, { state: 'pending' }> {
    if (document.isClosed) throw new Error('The case document is closed.')
    const entry = this.entry(document)
    clearTimeout(entry.timer)
    if (entry.snapshot.version === document.version && entry.snapshot.state !== 'pending')
      return entry.snapshot
    entry.sources = undefined
    const version = document.version
    const text = document.getText()
    let snapshot: Exclude<Snapshot, { state: 'pending' }>
    try {
      snapshot = { version, state: 'valid', case: parse(new TextEncoder().encode(text)) }
    } catch (error) {
      const issues =
        error instanceof CaseError
          ? [{ ...locate(text, error.path), message: error.message }]
          : error instanceof SyntaxError
            ? syntaxIssues(text)
            : []
      if (!issues.length) issues.push({ offset: 0, length: 0, message: describe(error) })
      snapshot = { version, state: 'invalid', issues }
    }
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
    return snapshot
  }

  source(document: vscode.TextDocument, ref: ElementRef): Span | undefined {
    const snapshot = this.read(document)
    if (snapshot.state !== 'valid') return
    const entry = this.entries.get(document)!
    entry.sources ??= indexElements(document.getText())
    return entry.sources.get(elementKey(ref))
  }

  dispose(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer)
    this.entries.clear()
    for (const disposable of this.subscriptions) disposable.dispose()
    this.diagnostics.dispose()
    this.changed.dispose()
  }
}
