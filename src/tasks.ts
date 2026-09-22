import { realpath } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import * as vscode from 'vscode'

import type { Cases } from './case.js'
import { command, uriOf } from './commands.js'
import { describe } from './errors.js'
import { parseSolver } from './gridkit/solver.js'
import { Run } from './run.js'
import {
  simulationCommand,
  SimulationConfigurationError,
  type SimulationOptions,
} from './runtime.js'
import {
  prepareSimulation,
  SOLVER_EXCLUDES,
  SOLVER_FILES,
  useConfiguration,
} from './simulation/setup.js'

export interface GridKitTaskDefinition extends vscode.TaskDefinition {
  type: 'gridkit'
  solver?: string
  case?: string
}
class SolverTerminal implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>()
  private readonly closed = new vscode.EventEmitter<number>()
  readonly onDidWrite = this.written.event
  readonly onDidClose = this.closed.event
  private run?: Run
  private cancelled = false
  constructor(private readonly prepare: () => Promise<Run>) {}
  open(): void {
    void (async () => {
      try {
        this.written.fire('Preparing DynamicSimulation...\r\n')
        this.run = await this.prepare()
        const matches = vscode.window.terminals.filter(
          (terminal) =>
            terminal.name === this.run!.taskName || terminal.name.endsWith(this.run!.taskName!),
        )
        this.run.terminal =
          vscode.window.terminals.find(
            (terminal) =>
              'pty' in terminal.creationOptions && terminal.creationOptions.pty === this,
          ) ?? (matches.length === 1 ? matches[0] : undefined)
        if (this.cancelled) await this.run.cancel()
        const code = await this.run.start((text) =>
          this.written.fire(text.replace(/\r?\n/g, '\r\n')),
        )
        if (this.run.error && this.run.status === 'failed') {
          const run = this.run
          void vscode.window.showErrorMessage(this.run.error, 'Show Terminal').then((choice) => {
            if (choice === 'Show Terminal')
              void vscode.commands.executeCommand('gridkitStudio.showSolverOutput', run)
          })
        }
        this.closed.fire(code)
      } catch (error) {
        this.written.fire(`${describe(error)}\r\n`)
        if (!this.cancelled) {
          const actions = error instanceof SimulationConfigurationError ? ['Open Settings'] : []
          void vscode.window.showErrorMessage(describe(error), ...actions).then((choice) => {
            if (choice === 'Open Settings')
              void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:lukelowery.gridkit-studio',
              )
          })
        }
        this.closed.fire(1)
      } finally {
        this.written.dispose()
        this.closed.dispose()
      }
    })()
  }
  close(): void {
    this.cancelled = true
    void this.run?.cancel()
  }
}
const workspacePath = (folder: vscode.WorkspaceFolder, uri: vscode.Uri) =>
  relative(folder.uri.fsPath, uri.fsPath).split('\\').join('/')

export function registerTasks(context: vscode.ExtensionContext, cases: Cases): void {
  const running = new Map<string, Run>()
  const preparing = new Set<string>()
  const diagnostics = vscode.languages.createDiagnosticCollection('gridkit-run')
  context.subscriptions.push(diagnostics)
  const prepare = async (definition: GridKitTaskDefinition, folder: vscode.WorkspaceFolder) => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running GridKit.')
    if (folder.uri.scheme !== 'file')
      throw new Error('Run GridKit in a local, WSL, SSH, or Dev Container workspace.')
    const uri = vscode.Uri.joinPath(folder.uri, (definition.solver ?? definition.case)!)
    let caseUri = uri
    if (definition.solver) {
      const input = parseSolver(
        JSON.parse((await vscode.workspace.openTextDocument(uri)).getText()),
      )
      caseUri = vscode.Uri.file(resolve(dirname(uri.fsPath), input.system_model_file))
    }
    const document = await vscode.workspace.openTextDocument(caseUri)
    const state = cases.resolve(cases.get(document).target)
    if (!state) throw new Error('Fix the case errors before running the simulation.')
    const key = await realpath(document.uri.fsPath)
    if (preparing.has(key)) throw new Error('This case is already preparing a simulation.')
    preparing.add(key)
    try {
      if (state.run?.status === 'running')
        throw new Error(
          'This case already has a running simulation. Stop it before starting another.',
        )
      state.assertCommitted()
      if (definition.solver) await useConfiguration(state, uri)
      const settings = vscode.workspace.getConfiguration('gridkitStudio', document.uri)
      const options: SimulationOptions = {
        method: settings.get('simulationMethod', 'auto'),
        executable: settings.get('dynamicSimulationPath', ''),
      }
      const launch = await prepareSimulation(cases, state, folder.uri.fsPath)
      let run: Run | undefined
      try {
        const command = await simulationCommand(launch, options)
        const outputPaths = new Set(launch.outputs)
        for (const open of vscode.workspace.textDocuments)
          if (open.isDirty && open.uri.scheme === 'file') {
            const path = await realpath(open.uri.fsPath).catch(() => open.uri.fsPath)
            if (outputPaths.has(path))
              throw new Error(
                'A monitor output has unsaved edits. Close or save it before running the solver.',
              )
          }
        for (const output of launch.outputs)
          if (running.get(output)?.status === 'running')
            throw new Error(
              'Another solver is writing this monitor output. Stop it before running this solver.',
            )
        launch.assertCurrent?.()
        run = new Run(state, launch, diagnostics, command)
        run.taskName = `Run ${definition.solver ?? definition.case}`
        for (const output of launch.outputs) running.set(output, run)
        void run.done.then(() => {
          for (const output of launch.outputs)
            if (running.get(output) === run) running.delete(output)
        })
        await state.attachRun(run)
        cases.activate(state)
        return run
      } catch (error) {
        if (run) {
          await run.dispose()
          if (state.run === run) await state.attachRun(undefined)
        } else await launch.cleanup?.()
        throw error
      }
    } finally {
      preparing.delete(key)
    }
  }
  const task = (definition: GridKitTaskDefinition, folder: vscode.WorkspaceFolder) => {
    const value = new vscode.Task(
      definition,
      folder,
      `Run ${definition.solver ?? definition.case}`,
      'GridKit',
      new vscode.CustomExecution(async () => new SolverTerminal(() => prepare(definition, folder))),
    )
    value.group = vscode.TaskGroup.Build
    value.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
      focus: false,
      showReuseMessage: false,
    }
    return value
  }
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider('gridkit', {
      async provideTasks() {
        if (!vscode.workspace.isTrusted) return []
        const files = await vscode.workspace.findFiles(SOLVER_FILES, SOLVER_EXCLUDES)
        return files.flatMap((uri) => {
          const folder = vscode.workspace.getWorkspaceFolder(uri)
          return folder
            ? [task({ type: 'gridkit', solver: workspacePath(folder, uri) }, folder)]
            : []
        })
      },
      resolveTask(value) {
        const definition = value.definition as GridKitTaskDefinition
        return (typeof definition.solver === 'string' || typeof definition.case === 'string') &&
          typeof value.scope === 'object'
          ? task(definition, value.scope)
          : undefined
      },
    }),
  )
  command(context, 'runSolver', async (argument) => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running GridKit.')
    const editorUri = vscode.window.activeTextEditor?.document.uri
    let uri =
      uriOf(argument) ??
      cases.active?.document.uri ??
      (editorUri && /\.(solver|case)\.json$/i.test(editorUri.path) ? editorUri : undefined)
    if (!uri) {
      const files = await vscode.workspace.findFiles('**/*.{case,solver}.json', SOLVER_EXCLUDES)
      uri = (
        await vscode.window.showQuickPick(
          files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
          { title: 'Run Simulation' },
        )
      )?.uri
    }
    if (!uri) return
    const folder = vscode.workspace.getWorkspaceFolder(uri)
    if (!folder) throw new Error('Open the case folder as a workspace first.')
    const path = workspacePath(folder, uri)
    const definition: GridKitTaskDefinition = /\.solver\.json$/i.test(uri.path)
      ? { type: 'gridkit', solver: path }
      : { type: 'gridkit', case: path }
    return vscode.tasks.executeTask(task(definition, folder))
  })
  command(context, 'showSolverOutput', (argument) => {
    const run = argument instanceof Run ? argument : cases.active?.run
    if (run?.terminal && vscode.window.terminals.includes(run.terminal)) run.terminal.show(true)
    else
      void vscode.window.showInformationMessage('This simulation task terminal is no longer open.')
  })
  command(context, 'stopSolver', () => cases.active?.run?.cancel())
  command(context, 'clearRun', () => cases.active?.attachRun(undefined))
}
