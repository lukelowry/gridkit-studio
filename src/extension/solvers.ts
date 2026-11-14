/** Solver files, read where they are: the case each names, the state file it starts that case
 *  from, and the file its runs write. */

import * as vscode from 'vscode'

import { stat } from '../platform/files.js'
import { outputPath } from '../platform/host.js'
import { isAbsolute } from '../platform/path.js'
import type { Summary } from '../shared/messages.js'
import { outputOf, readSolver, type Solver } from '../shared/study.js'
import { reference, uriOf } from './uris.js'

/** A file's name, as its path ends. */
export const nameOf = (uri: vscode.Uri) => uri.path.split('/').at(-1)!

/** `path` as GridKit reads it in the solver file `solver`: relative to its folder unless absolute. */
const near = (solver: vscode.Uri, path: string) =>
  isAbsolute(path)
    ? path.startsWith('/') && solver.scheme !== 'file'
      ? solver.with({ path })
      : uriOf(path)
    : vscode.Uri.joinPath(solver, '..', path)

/** The solver file at `solver` as saved, what it says, the case it names, and the state file it
 *  names, if any. */
export async function solverAt(solver: vscode.Uri) {
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(solver))
  const study = readSolver(nameOf(solver), text)
  return {
    study,
    model: near(solver, study.model),
    ...(study.state !== undefined && { state: near(solver, study.state) }),
  }
}

/** The file a run of `solver`, which `study` says, writes its samples to for the case `summary`
 *  reads, by GridKit's rule. */
export const writtenBy = (solver: vscode.Uri, study: Solver, summary: Summary): vscode.Uri =>
  uriOf(
    outputPath(
      reference(near(solver, outputOf(nameOf(solver), study, summary.recording.monitor).file)),
    ),
  )

/** Whether `uri` names a file that is there. */
export const exists = (uri: vscode.Uri) =>
  Promise.resolve(stat(reference(uri))).then(
    () => true,
    () => false,
  )

/** Whether `uri` names a file that is gone: one that cannot be reached now, on a remote or network
 *  drive, is not. */
export const gone = (uri: vscode.Uri) =>
  Promise.resolve(stat(reference(uri))).then(
    () => false,
    (error: unknown) => (error as { code?: string })?.code === 'ENOENT',
  )

/** The file the solver file at `path` writes now for the case `summary` reads, when it names that
 *  case and the file is there. */
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
