/** GridKit's programs, run on a .solver.json from its menu as a shell runs them:
 *  `DynamicSimulation IEEE39.solver.json` in the solver file's folder. The solver file names the
 *  case, whose Monitor shows the run. A notification says how far it has come, and cancelling it
 *  stops the run. The same menu shows what a solver file's last run wrote, and the Monitor runs the
 *  solver file of the results it shows again. */

import { dirname, resolve } from 'node:path'

import * as vscode from 'vscode'

import { formatNumber } from '../shared/format.js'
import type { GridKit, Program, Results } from '../shared/messages.js'
import { cacheBytesOf, notice, type Sessions } from './sessions.js'
import { exists, nameOf, solverAt, writtenBy } from './solvers.js'
import { showView } from './views.js'

/** The GridKit install the settings name for the case at `uri`; a relative path resolves against
 *  its workspace folder. */
export function gridkitOf(uri: vscode.Uri): GridKit {
  const settings = vscode.workspace.getConfiguration('gridkitStudio', uri)
  const path = settings.get<string>('gridkitPath', '').trim()
  return {
    path: path
      ? resolve(vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? dirname(uri.fsPath), path)
      : '',
    image: settings.get<string>('gridkitImage', '').trim(),
    cli: settings.get<string>('containerCli', '').trim(),
  }
}

/** Where Problems lists why a case cannot be read. */
const PROBLEMS = { title: 'Show Problems', command: 'workbench.actions.view.problems' }

/** The solver file a menu was opened on, which must be on this machine. */
function solverOf(target: unknown, doing: string): vscode.Uri {
  if (!(target instanceof vscode.Uri) || target.scheme !== 'file')
    throw new Error(`Right-click a .solver.json on this machine to ${doing}.`)
  return target
}

/** How far a run has come, by the `results` it has written so far, in percent and in words. A
 *  study runs its contingencies at once, so only a simulation counts. */
function progressOf(program: Program, results?: Results) {
  if (program === 'ContingencyAnalysis') return { percent: 0, message: 'Faulting each bus' }
  const { span, domain, frames } = results ?? {}
  if (!frames || !span || !domain || !(span[1] > span[0]))
    return { percent: 0, message: 'Starting' }
  return {
    percent: (100 * (domain[1] - span[0])) / (span[1] - span[0]),
    message: `${formatNumber(domain[1])} of ${formatNumber(span[1])} s`,
  }
}

export function registerRuns(studio: Sessions) {
  /** Each case's run, from its menu until it ends. Aborting one stops it. */
  const runs = new Map<string, AbortController>()

  const run = (program: Program) => async (target: unknown) => {
    const solver = solverOf(target, 'run it')
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
    const { document: input, study, model } = await solverAt(solver)
    const uri = model.toString()
    if (runs.has(uri)) throw new Error(`${nameOf(model)} is already running.`)
    const stop = new AbortController()
    runs.set(uri, stop)
    try {
      const document = await vscode.workspace.openTextDocument(model)
      // GridKit reads the files as saved, so they are saved first, as VS Code's tasks do.
      for (const each of [input, document])
        if (each.isDirty && !(await each.save()))
          throw new Error(`${nameOf(each.uri)} was not saved.`)
      // The Monitor reads the output against the case, so Studio must read the case. Whether
      // GridKit accepts it is GridKit's to say.
      const summary = await studio.documents.ensure(document).catch(() => undefined)
      if (!summary)
        throw notice(`${nameOf(model)} has problems to fix before it can run.`, PROBLEMS)
      if (!Object.keys(summary.recording.listed).length)
        throw notice(`${nameOf(model)} records nothing.`, {
          title: 'Choose Signals',
          command: 'gridkitStudio.chooseSignals',
        })
      const output = writtenBy(solver, study, summary)
      // A run removes the file it writes before it starts, so that file must not be one it reads.
      if ([solver, model].some((file) => file.toString() === output.toString()))
        throw new Error(`${nameOf(solver)} would write its samples over ${nameOf(output)}.`)
      await studio.open(document)
      await showView('monitor')
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${program} ${nameOf(solver)}`,
          cancellable: true,
        },
        async (progress, token) => {
          let shown = 0
          const report = (results?: Results) => {
            const { percent, message } = progressOf(program, results)
            progress.report({ increment: percent - shown, message })
            shown = percent
          }
          /** The results the run writes, once it begins to. */
          let writes: string | undefined
          const listening = [
            token.onCancellationRequested(() => stop.abort()),
            studio.client.event.event((event) => {
              if (event.kind === 'run' && event.run.uri === uri) {
                writes = event.run.results
                if (!writes) report()
              } else if (event.kind === 'results' && event.results.id === writes)
                report(event.results)
            }),
          ]
          try {
            // The call is the run. It settles when the run ends, and aborting it stops the run.
            // The case is as GridKit reads it, saved, which the results are read against.
            await studio.withCase(uri, (source) =>
              studio.client.results.call(
                'run',
                {
                  ...source,
                  program,
                  solver: solver.fsPath,
                  output: output.fsPath,
                  tmax: study.tmax,
                  // What a container mounts: the solver file's workspace folder.
                  root: (
                    vscode.workspace.getWorkspaceFolder(solver)?.uri ??
                    vscode.Uri.joinPath(solver, '..')
                  ).fsPath,
                  gridkit: gridkitOf(model),
                  cacheBytes: cacheBytesOf(model),
                },
                stop.signal,
              ),
            )
          } finally {
            for (const each of listening) each.dispose()
          }
        },
      )
    } finally {
      runs.delete(uri)
    }
  }

  /** Shows what a solver file's last simulation wrote, read against its case, without running it. */
  const show = async (target: unknown) => {
    const solver = solverOf(target, 'show its results')
    const { study, model } = await solverAt(solver)
    const document = await vscode.workspace.openTextDocument(model)
    const summary = await studio.documents.ensure(document).catch(() => undefined)
    if (!summary)
      throw notice(`${nameOf(model)} has problems to fix before its results can be read.`, PROBLEMS)
    const output = writtenBy(solver, study, summary)
    if (!(await exists(output)))
      throw new Error(`${nameOf(solver)} has written no ${nameOf(output)} yet. Run it first.`)
    const session = await studio.open(document)
    await showView('monitor')
    const results = await studio.withCase(session.uri, (source) =>
      studio.client.results.call('open', {
        ...source,
        path: output.fsPath,
        solver: solver.fsPath,
        cacheBytes: cacheBytesOf(model),
      }),
    )
    studio.show(session, results, false)
    studio.changed.fire(session.uri)
  }

  return [
    studio.command('gridkitStudio.runSimulation', run('DynamicSimulation')),
    studio.command('gridkitStudio.runContingencies', run('ContingencyAnalysis')),
    studio.command('gridkitStudio.stopSimulation', () => runs.get(studio.active ?? '')?.abort()),
    studio.command('gridkitStudio.showResults', show),
    // The solver file of the results on show, run as they were: a study's again as a study.
    studio.command('gridkitStudio.runAgain', () => {
      const { solver, contingency } = studio.current().results ?? {}
      if (!solver) throw new Error('These results were not written by a run of a solver file.')
      return run(contingency ? 'ContingencyAnalysis' : 'DynamicSimulation')(vscode.Uri.file(solver))
    }),
  ]
}
