/** Runs a .solver.json from its context menu as a shell would, as in
 *  `DynamicSimulation IEEE39.solver.json` in its folder. Cancelling the notification stops it. */

import * as vscode from 'vscode'

import { nameOf } from '../platform/path.js'
import { fileKey } from '../results/index.js'
import { formatNumber } from '../shared/format.js'
import type { Results } from '../shared/messages.js'
import type { Commands } from './commands.js'
import { gridkitOf } from './settings.js'
import { exists, solverAt, writtenBy } from './solvers.js'
import { reference } from './uris.js'

function solverOf(target: unknown, doing: string): vscode.Uri {
  if (!(target instanceof vscode.Uri)) throw new Error(`Right-click a .solver.json to ${doing}.`)
  return target
}

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

/** A run's progress from the `results` written so far, as a percentage and a message. */
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
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to run GridKit.')
    const solver = solverOf(target, 'run it')
    // GridKit and Studio read the files from disk, so save unsaved editors first, as tasks do.
    await vscode.workspace.save(solver)
    const { study, model, state } = await solverAt(solver)
    await vscode.workspace.save(model)
    if (state) await vscode.workspace.save(state)
    const session = studio.activate(model.toString())
    // The Monitor reads the output against the case, so Studio must be able to read the case.
    // Whether GridKit accepts it is up to GridKit.
    const summary = await studio.files.readable(model.toString(), 'it can run')
    if (!summary.recording.anything)
      throw new Error(
        `${nameOf(model.toString())} records nothing: no record lists a signal in its mon list.`,
      )
    const output = writtenBy(solver, study, summary)
    // GridKit overwrites its output file, so it must not be one of the run's inputs.
    const read = [solver, model, ...(state ? [state] : [])]
    if (read.some((file) => fileKey(reference(file)) === fileKey(reference(output))))
      throw new Error(
        `${nameOf(solver.toString())} would write its samples over ${nameOf(output.toString())}.`,
      )
    const gridkit = gridkitOf(solver)
    await studio.showView('monitor')
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${gridkit.program} ${nameOf(solver.toString())}`,
        cancellable: true,
      },
      async (progress, token) => {
        let reported = 0
        // Settles when the run ends. Progress follows what the run has written, not what the
        // views show.
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
              progress.report({ increment: Math.max(0, percent - reported), message })
              reported = Math.max(reported, percent)
            },
          ),
        )
      },
    )
  }

  /** Shows the output of a solver file's last run without running it. */
  const show = async (target: unknown) => {
    const solver = solverOf(target, 'show its results')
    const { study, model } = await solverAt(solver)
    const session = studio.activate(model.toString())
    const summary = await studio.files.readable(model.toString(), 'its results can be read')
    const output = writtenBy(solver, study, summary)
    if (!(await exists(output)))
      throw new Error(
        `${nameOf(solver.toString())} has written no ${nameOf(output.toString())} yet. Run it first.`,
      )
    await studio.showView('monitor')
    await session.load(reference(output), reference(solver))
  }

  // A run starts only from a solver file's menu, as do its last results. Stop acts on the active
  // case.
  registrations.push(studio.command('runSimulation', run), studio.command('showLastResults', show))
  command('stopSimulation', ({ session }) => session.stop())
}
