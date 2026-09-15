import * as vscode from 'vscode'

import type { CaseState } from './case.js'
import type { SolverIssue } from './gridkit/output.js'
import { locate } from './gridkit/source.js'
/** Resolve only explicit GridKit references; unlocated failures remain in the task terminal. */
export function solverDiagnostic(
  state: CaseState,
  issue: SolverIssue,
): vscode.Diagnostic | undefined {
  const raw = state.raw
  if (!issue.device || !raw) return
  const { className, id } = issue.device
  const index = raw.devices.findIndex((device) => device.class === className && device.id === id)
  if (index < 0) return
  const path: (string | number)[] = ['devices', index]
  if (issue.parameter) path.push('params', issue.parameter)
  const text = state.document.getText()
  const span = locate(text, path)
  const value = new vscode.Diagnostic(
    new vscode.Range(
      state.document.positionAt(span.offset),
      state.document.positionAt(span.offset + span.length),
    ),
    issue.message,
    issue.severity === 'error'
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning,
  )
  value.source = 'GridKit'
  return value
}
