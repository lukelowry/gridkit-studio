import type { Value } from '@latkit/model'
import * as vscode from 'vscode'

import type { Client } from './client.js'
import type { Element, Summary } from './messages.js'
interface Entry {
  document: vscode.TextDocument
  summary?: Summary
  pending?: Promise<Summary>
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  stale: boolean
  error?: string
}
export class Documents {
  readonly entries = new Map<string, Entry>()
  readonly changed = new vscode.EventEmitter<string>()
  readonly diagnostics = vscode.languages.createDiagnosticCollection('gridkit')
  readonly disposables: vscode.Disposable[]
  constructor(readonly client: Client) {
    this.disposables = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        const entry = this.entries.get(event.document.uri.toString())
        if (!entry || !event.contentChanges.length) return
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
        clearTimeout(entry?.timer)
        this.entries.delete(uri)
        this.changed.fire(uri)
        this.diagnostics.delete(document.uri)
        void this.client.call('release', { uri }).catch(() => {})
      }),
      this.client.failure.event((error) => {
        for (const [uri, entry] of this.entries) {
          entry.stale = true
          entry.error = error.message
          entry.pending = undefined
          this.changed.fire(uri)
        }
      }),
    ]
  }
  async ensure(document: vscode.TextDocument): Promise<Summary> {
    const entry = this.entries.get(document.uri.toString())
    if (entry?.summary?.version === document.version && !entry.stale) return entry.summary
    return entry?.pending ?? this.parse(document)
  }
  parse(document: vscode.TextDocument): Promise<Summary> {
    const uri = document.uri.toString()
    let entry = this.entries.get(uri)
    if (!entry) {
      entry = { document, stale: true }
      this.entries.set(uri, entry)
    }
    entry.controller?.abort()
    clearTimeout(entry.timer)
    const controller = (entry.controller = new AbortController())
    const version = document.version
    const current = entry
    const pending = this.client
      .call('parse', { uri, version, text: document.getText() }, controller.signal)
      .then(
        (summary) => {
          if (document.version !== version || controller.signal.aborted)
            throw new Error('Superseded revision')
          current.summary = summary
          current.stale = false
          current.error = undefined
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
          throw error
        },
      )
      .finally(() => {
        if (current.pending === pending) current.pending = undefined
      })
    entry.pending = pending
    return pending
  }
  async edit(uri: string, expected: number, element: Element & { field: string }, value: Value) {
    const entry = this.entries.get(uri)
    if (!entry || entry.document.version !== expected || entry.stale)
      throw new Error('The document changed. Refresh before editing.')
    const edits = await this.client.call('edit', { uri, version: expected, ...element, value })
    if (entry.document.version !== expected || entry.stale)
      throw new Error('The document changed before this edit could be applied.')
    const edit = new vscode.WorkspaceEdit()
    edit.set(
      entry.document.uri,
      edits.map((change) =>
        vscode.TextEdit.replace(
          new vscode.Range(
            entry.document.positionAt(change.offset),
            entry.document.positionAt(change.offset + change.length),
          ),
          change.text,
        ),
      ),
    )
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error('VS Code could not apply the edit.')
  }
  async reveal(uri: string, element?: Element) {
    const document =
      this.entries.get(uri)?.document ??
      (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)))
    const summary = await this.ensure(document)
    const source = element
      ? await this.client.call('locate', { uri, version: summary.version, ...element })
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
