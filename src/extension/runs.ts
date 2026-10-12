/** GridKit's DynamicSimulation, run on a .solver.json from its menu as a shell runs it:
 *  `DynamicSimulation IEEE39.solver.json` in the solver file's folder. The solver file names the
 *  case, whose Monitor shows the run. A notification says how far it has come, and cancelling it
 *  stops the run. The same menu shows what a solver file's last run wrote, and the Monitor runs the
 *  solver file of the results it shows again. */

import * as vscode from 'vscode'

import { PROGRAM } from '../gridkit/index.js'
import { formatNumber } from '../shared/format.js'
import { commandId } from '../shared/ids.js'
import type { Results } from '../shared/messages.js'
import { cancellable } from './client.js'
import { notice, SHOW_PROBLEMS } from './report.js'
import type { Sessions } from './sessions.js'
import { gridkitOf } from './settings.js'
import { exists, nameOf, solverAt, writtenBy } from './solvers.js'
import { showView } from './views.js'

/** The solver file a menu was opened on, which must be on this machine. */
function solverOf(target: unknown, doing: string): vscode.Uri {
  if (!(target instanceof vscode.Uri) || target.scheme !== 'file')
    throw new Error(`Right-click a .solver.json on this machine to ${doing}.`)
  return target
}

/** How far a run has come, by the `results` it has written so far, in percent and in words. */
function progressOf(results?: Results) {
  const { span, domain, frames } = results ?? {}
  if (!frames || !span || !domain || !(span[1] > span[0]))
    return { percent: 0, message: 'Starting' }
  return {
    percent: (100 * (domain[1] - span[0])) / (span[1] - span[0]),
    message: `${formatNumber(domain[1])} of ${formatNumber(span[1])} s`,
  }
}

export function registerRuns(studio: Sessions) {
  /** The solver file `target` names, what it says, and the case it names, read as GridKit reads
   *  them, with the file a run of it writes. */
  const solverRun = async (target: unknown, doing: string) => {
    const solver = solverOf(target, doing)
    const { document: input, study, model } = await solverAt(solver)
    const document = await vscode.workspace.openTextDocument(model)
    return { solver, input, study, model, document }
  }
  /** The case `document` holds, as it reads, or a notice that it has problems to fix `before`. */
  const readable = async (document: vscode.TextDocument, before: string) => {
    const summary = await studio.documents.parsed(document)
    if (!summary)
      throw notice(`${nameOf(document.uri)} has problems to fix before ${before}.`, SHOW_PROBLEMS)
    return summary
  }

  const run = async (target: unknown) => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
    const { solver, input, study, model, document } = await solverRun(target, 'run it')
    // GridKit reads the files as saved, so they are saved first, as VS Code's tasks do.
    for (const each of [input, document])
      if (each.isDirty && !(await each.save()))
        throw new Error(`${nameOf(each.uri)} was not saved.`)
    // The Monitor reads the output against the case, so Studio must read the case. Whether
    // GridKit accepts it is GridKit's to say.
    const summary = await readable(document, 'it can run')
    if (!Object.keys(summary.recording.listed).length)
      throw notice(`${nameOf(model)} records nothing.`, {
        title: 'Choose Signals',
        command: commandId('chooseSignals'),
      })
    const output = writtenBy(solver, study, summary)
    // A run removes the file it writes before it starts, so that file must not be one it reads.
    if ([solver, model].some((file) => file.toString() === output.toString()))
      throw new Error(`${nameOf(solver)} would write its samples over ${nameOf(output)}.`)
    const session = await studio.open(document)
    await showView('monitor')
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${PROGRAM} ${nameOf(solver)}`,
        cancellable: true,
      },
      async (progress, token) => {
        let shown = 0
        // The run's results are those on show while it runs.
        const following = studio.changed.event((uri) => {
          if (uri !== session.uri || !session.running) return
          const { percent, message } = progressOf(session.results)
          progress.report({ increment: percent - shown, message })
          shown = percent
        })
        try {
          // The call is the run. It settles when the run ends, and cancelling it stops the run.
          await cancellable(token, (signal) =>
            session.start(
              {
                solver: solver.fsPath,
                output: output.fsPath,
                tmax: study.tmax,
                // What a container mounts: the solver file's workspace folder.
                root: (
                  vscode.workspace.getWorkspaceFolder(solver)?.uri ??
                  vscode.Uri.joinPath(solver, '..')
                ).fsPath,
                gridkit: gridkitOf(model),
              },
              signal,
            ),
          )
        } finally {
          following.dispose()
        }
      },
    )
  }

  /** Shows what a solver file's last simulation wrote, read against its case, without running it. */
  const show = async (target: unknown) => {
    const { solver, study, document } = await solverRun(target, 'show its results')
    const output = writtenBy(solver, study, await readable(document, 'its results can be read'))
    if (!(await exists(output)))
      throw new Error(`${nameOf(solver)} has written no ${nameOf(output)} yet. Run it first.`)
    const session = await studio.open(document)
    await showView('monitor')
    await session.load(output.fsPath, solver.fsPath)
  }

  return [
    studio.command('runSimulation', run),
    studio.command('stopSimulation', () => studio.current().stop()),
    studio.command('showResults', show),
    // The solver file of the results on show, run again.
    studio.command('runAgain', () => {
      const { solver } = studio.current().results ?? {}
      if (!solver) throw new Error('These results were not written by a run of a solver file.')
      return run(vscode.Uri.file(solver))
    }),
  ]
}
