/** Solver files, read where they are: the case each names, and the file its runs write. */

import { isAbsolute } from 'node:path'

import * as vscode from 'vscode'

import type { Summary } from '../shared/messages.js'
import { outputOf, readSolver, type Solver } from '../shared/study.js'

/** A file's name, as its path ends. */
export const nameOf = (uri: vscode.Uri) => uri.path.split('/').at(-1)!

/** `path` as GridKit reads it in the solver file `solver`: relative to its folder unless absolute. */
const near = (solver: vscode.Uri, path: string) =>
  isAbsolute(path) ? vscode.Uri.file(path) : vscode.Uri.joinPath(solver, '..', path)

/** The solver file at `solver`, as its editor holds it, what it says, and the case it names. */
export async function solverAt(solver: vscode.Uri) {
  const document = await vscode.workspace.openTextDocument(solver)
  const study = readSolver(nameOf(solver), document.getText())
  return { document, study, model: near(solver, study.model) }
}

/** The file a run of `study` writes its samples to, by GridKit's rule. */
export const writtenBy = (solver: vscode.Uri, study: Solver, summary: Summary): vscode.Uri =>
  near(solver, outputOf(nameOf(solver), study, summary.recording.monitor).file)

/** Whether `uri` names a file that is there. */
export const exists = (uri: vscode.Uri) =>
  Promise.resolve(vscode.workspace.fs.stat(uri)).then(
    () => true,
    () => false,
  )
