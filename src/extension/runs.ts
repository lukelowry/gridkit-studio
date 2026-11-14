/** GridKit's DynamicSimulation, run on a .solver.json from its menu as a shell runs it:
 *  `DynamicSimulation IEEE39.solver.json` in the solver file's folder. The solver file names the
 *  case, whose Monitor shows the run. A notification says how far it has come, and cancelling it
 *  stops the run. The same menu shows what a solver file's last run wrote, and the Monitor runs the
 *  solver file of the results it shows again. */

import * as vscode from 'vscode'

import { fileKey } from '../results/index.js'
import { formatNumber } from '../shared/format.js'
import type { Results } from '../shared/messages.js'
import type { Commands } from './commands.js'
import { gridkitOf } from './settings.js'
import { exists, nameOf, solverAt, writtenBy } from './solvers.js'
import { reference, uriOf } from './uris.js'

/** The solver file a menu was opened on, wherever its workspace is. */
function solverOf(target: unknown, doing: string): vscode.Uri {
  if (!(target instanceof vscode.Uri)) throw new Error(`Right-click a .solver.json to ${doing}.`)
  return target
}

/** Run `run` with a signal that aborts when `token` is cancelled. */
async function cancellable<T>(
  token: vscode.CancellationToken,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const subscription = token.onCancellationRequested(() => controller.abort())
  if (token.isCancellationRequested) controller.abort()
  try {
    return await run(controller.signal)
  } finally {
    subscription.dispose()
  }
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

export function registerRuns({ studio, registrations, command }: Commands) {
  const run = async (target: unknown) => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
    const solver = solverOf(target, 'run it')
    // GridKit reads the files as saved, and so does Studio: an editor of any with unsaved changes
    // is saved first, as VS Code's tasks do.
    await vscode.workspace.save(solver)
    const { study, model, state } = await solverAt(solver)
    await vscode.workspace.save(model)
    if (state) await vscode.workspace.save(state)
    const session = studio.activate(model.toString())
    // The Monitor reads the output against the case, so Studio must read the case. Whether
    // GridKit accepts it is GridKit's to say.
    const summary = await studio.files.readable(model.toString(), 'it can run')
    if (!summary.recording.anything)
      throw new Error(`${nameOf(model)} records nothing: no record lists a signal in its mon list.`)
    const output = writtenBy(solver, study, summary)
    // GridKit writes over the file it writes to, so that file must not be one the run reads.
    const read = [solver, model, ...(state ? [state] : [])]
    if (read.some((file) => fileKey(reference(file)) === fileKey(reference(output))))
      throw new Error(`${nameOf(solver)} would write its samples over ${nameOf(output)}.`)
    // Resolve an explicit installation on the workspace host, or select bundled WASM.
    const gridkit = gridkitOf(solver)
    await studio.showView('monitor')
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${gridkit.program} ${nameOf(solver)}`,
        cancellable: true,
      },
      async (progress, token) => {
        let shown = 0
        // The call is the run. It settles when the run ends, and cancelling it stops the run. It
        // says how far it has come by what it has written, whatever the views show meanwhile.
        await cancellable(token, (signal) =>
          session.start(
            {
              solver: reference(solver),
              output: reference(output),
              ...(state && { state: reference(state) }),
              tmax: study.tmax,
              gridkit,
            },
            signal,
            (written) => {
              const { percent, message } = progressOf(written)
              progress.report({ increment: Math.max(0, percent - shown), message })
              shown = Math.max(shown, percent)
            },
          ),
        )
      },
    )
  }

  /** Shows what a solver file's last simulation wrote, read against its case, without running it. */
  const show = async (target: unknown) => {
    const solver = solverOf(target, 'show its results')
    const { study, model } = await solverAt(solver)
    const session = studio.activate(model.toString())
    const summary = await studio.files.readable(model.toString(), 'its results can be read')
    const output = writtenBy(solver, study, summary)
    if (!(await exists(output)))
      throw new Error(`${nameOf(solver)} has written no ${nameOf(output)} yet. Run it first.`)
    await studio.showView('monitor')
    await session.load(reference(output), reference(solver))
  }

  // A run is of a solver file, which its menu names; the rest are of the case the views follow.
  registrations.push(studio.command('runSimulation', run), studio.command('showLastResults', show))
  command('stopSimulation', ({ session }) => session.stop())
  // The solver file of the results on show, run again.
  command('runSimulationAgain', ({ session }) => {
    const { solver } = session.results ?? {}
    if (!solver) throw new Error('These results were not written by a run of a solver file.')
    return run(uriOf(solver))
  })
}
