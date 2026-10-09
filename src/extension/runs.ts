/** GridKit's programs, run on a .solver.json from its menu as a shell runs them:
 *  `DynamicSimulation IEEE39.solver.json` in the solver file's folder. The solver file names the
 *  case, whose Monitor shows the run. A notification says how far it has come, and cancelling it
 *  stops the run. */

import { dirname, isAbsolute, resolve } from 'node:path'

import * as vscode from 'vscode'

import { formatNumber } from '../shared/format.js'
import type { GridKit, Program, Run } from '../shared/messages.js'
import { outputOf, readSolver } from '../shared/study.js'
import { cacheBytesOf, notice, type Sessions } from './sessions.js'
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

const nameOf = (uri: vscode.Uri) => uri.path.split('/').at(-1)!

/** `path` as GridKit reads it in the solver file `solver`: relative to its folder unless absolute. */
const near = (solver: vscode.Uri, path: string) =>
  isAbsolute(path) ? vscode.Uri.file(path) : vscode.Uri.joinPath(solver, '..', path)

/** How far a run has come, in percent and in words. A study runs its contingencies at once, so
 *  only a simulation counts. */
function progressOf(program: Program, { state, results }: Run) {
  if (program === 'ContingencyAnalysis') return { percent: 0, message: 'Faulting each bus' }
  const { span, domain, frames } = results ?? {}
  if (state !== 'running' || !frames || !span || !domain || !(span[1] > span[0]))
    return { percent: 0, message: 'Starting' }
  return {
    percent: (100 * (domain[1] - span[0])) / (span[1] - span[0]),
    message: `${formatNumber(domain[1])} of ${formatNumber(span[1])} s`,
  }
}

export function registerRuns(studio: Sessions) {
  /** Each case's run, from its menu until it ends. Aborting one stops it. */
  const runs = new Map<string, AbortController>()

  const run = (program: Program) => async (solver: unknown) => {
    if (!(solver instanceof vscode.Uri) || solver.scheme !== 'file')
      throw new Error('Right-click a .solver.json on this machine to run it.')
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
    const input = await vscode.workspace.openTextDocument(solver)
    const study = readSolver(nameOf(solver), input.getText())
    const model = near(solver, study.model)
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
        throw notice(`${nameOf(model)} has problems to fix before it can run.`, {
          title: 'Show Problems',
          command: 'workbench.actions.view.problems',
        })
      if (!Object.keys(summary.recording.listed).length)
        throw notice(`${nameOf(model)} records nothing.`, {
          title: 'Choose Signals',
          command: 'gridkitStudio.chooseSignals',
        })
      const sink = outputOf(nameOf(solver), study, summary.recording.monitor)
      const output = near(solver, sink.file)
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
          const listening = [
            token.onCancellationRequested(() => stop.abort()),
            studio.client.event.event((event) => {
              if (event.kind !== 'run' || event.run.uri !== uri) return
              const { percent, message } = progressOf(program, event.run)
              progress.report({ increment: percent - shown, message })
              shown = percent
            }),
          ]
          try {
            // The call is the run. It settles when the run ends, and aborting it stops the run.
            await studio.client.call(
              'run',
              {
                uri,
                version: summary.version,
                program,
                solver: solver.fsPath,
                output: output.fsPath,
                format: sink.format,
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

  return [
    studio.command('gridkitStudio.runSimulation', run('DynamicSimulation')),
    studio.command('gridkitStudio.runContingencies', run('ContingencyAnalysis')),
    studio.command('gridkitStudio.stopSimulation', () => runs.get(studio.active ?? '')?.abort()),
  ]
}
