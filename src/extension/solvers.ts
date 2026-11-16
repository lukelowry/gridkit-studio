/** Reads solver files: the case each names, its optional state file, and the output its runs
 *  write. */

import * as vscode from 'vscode'

import { stat } from '../platform/files.js'
import { outputPath } from '../platform/host.js'
import { isAbsolute, nameOf } from '../platform/path.js'
import type { Summary } from '../shared/messages.js'
import { outputOf, readSolver, type Solver } from '../shared/study.js'
import { reference, uriOf } from './uris.js'

/** Resolves `path` as GridKit does in `solver`: relative to its folder unless absolute. */
const near = (solver: vscode.Uri, path: string) =>
  isAbsolute(path)
    ? path.startsWith('/') && solver.scheme !== 'file'
      ? solver.with({ path })
      : uriOf(path)
    : vscode.Uri.joinPath(solver, '..', path)

export async function solverAt(solver: vscode.Uri) {
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(solver))
  const study = readSolver(nameOf(solver.toString()), text)
  return {
    study,
    model: near(solver, study.model),
    ...(study.state !== undefined && { state: near(solver, study.state) }),
  }
}

/** The output file a run of `solver` writes for the case `summary`, by GridKit's rule. */
export const writtenBy = (solver: vscode.Uri, study: Solver, summary: Summary): vscode.Uri =>
  uriOf(
    outputPath(
      reference(
        near(solver, outputOf(nameOf(solver.toString()), study, summary.recording.monitor).file),
      ),
    ),
  )

export const exists = (uri: vscode.Uri) =>
  Promise.resolve(stat(reference(uri))).then(
    () => true,
    () => false,
  )

/** Whether the file at `uri` does not exist. An unreachable file (remote or network drive) does
 *  not count as gone. */
export const gone = (uri: vscode.Uri) =>
  Promise.resolve(stat(reference(uri))).then(
    () => false,
    (error: unknown) => (error as { code?: string })?.code === 'ENOENT',
  )

/** The output the solver file at `path` currently writes for `summary`'s case, if it names that
 *  case and the output exists. */
export async function writtenNow(path: string, summary: Summary): Promise<string | undefined> {
  try {
    const solver = uriOf(path)
    const { study, model } = await solverAt(solver)
    if (model.toString() !== summary.uri) return undefined
    const uri = writtenBy(solver, study, summary)
    return (await exists(uri)) ? reference(uri) : undefined
  } catch {
    return undefined
  }
}
