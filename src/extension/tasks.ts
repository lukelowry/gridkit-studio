import { dirname, resolve } from 'node:path'

import * as vscode from 'vscode'

import { message } from '../shared/format.js'
import type { GridKit, SimulationRequest } from '../shared/messages.js'
import type { Sessions } from './sessions.js'

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

/** The `resultCacheMiB` setting for `uri`, in bytes. */
export function cacheBytesOf(uri: vscode.Uri) {
  return (
    vscode.workspace.getConfiguration('gridkitStudio', uri).get<number>('resultCacheMiB', 256) *
    (1 << 20)
  )
}

/** A run being started: settled once GridKit's run begins, rejected with why it could not. */
interface Launch {
  /** Whether a task's terminal has taken it up. */
  claimed: boolean
  begun(): void
  failed(error: unknown): void
}

export function registerTasks(studio: Sessions) {
  /** The runs being started, by case. */
  const launches = new Map<string, Launch>()
  /** Track a run of the case at `uri` being started: its views say Starting… until GridKit's run
   *  begins. `done` settles then, or rejects with why the run could not begin. */
  const track = (uri: string) => {
    let launch!: Launch
    const done = new Promise<void>((resolve, reject) => {
      launch = {
        claimed: false,
        begun: resolve,
        failed: (error) => (error ? reject(error) : resolve()),
      }
    }).finally(() => {
      if (launches.get(uri) === launch) launches.delete(uri)
      const session = studio.all.get(uri)
      if (session) session.launching = false
      studio.changed.fire(uri)
    })
    launches.set(uri, launch)
    const session = studio.all.get(uri)
    if (session) session.launching = true
    studio.changed.fire(uri)
    return { launch, done }
  }
  /** Whether the case at `uri` is running, or a run of it is starting. */
  const active = (uri: string) => launches.has(uri) || studio.all.get(uri)?.run?.state === 'running'
  const make = (
    uri: vscode.Uri,
    values?: Record<string, unknown>,
    captured?: SimulationRequest,
  ) => {
    const definition = {
      type: 'gridkit',
      case: uri.toString(),
      ...(values ? { values } : {}),
    }
    const task = new vscode.Task(
      definition,
      vscode.workspace.getWorkspaceFolder(uri) ?? vscode.TaskScope.Workspace,
      'Simulate ' + uri.path.split('/').at(-1),
      'GridKit',
      new vscode.CustomExecution(async () => {
        const write = new vscode.EventEmitter<string>()
        const close = new vscode.EventEmitter<number>()
        const key = uri.toString()
        // Run's own launch; a run from the Tasks menu is tracked here, as Run's is. One that starts
        // while another runs or starts is refused.
        const found = launches.get(key)
        const duplicate = !!found?.claimed || (!found && active(key))
        const launch = duplicate ? undefined : (found ?? track(key).launch)
        if (launch) launch.claimed = true
        let subscription: vscode.Disposable | undefined
        let request = captured && structuredClone(captured)
        let begun = false
        let cancelled = false
        const terminal: vscode.Pseudoterminal = {
          onDidWrite: write.event,
          onDidClose: close.event,
          open() {
            void (async () => {
              if (duplicate) throw new Error('A simulation is already active for this case.')
              if (!vscode.workspace.isTrusted)
                throw new Error('Trust this workspace to execute GridKit.')
              if (!request) {
                const document = await vscode.workspace.openTextDocument(uri)
                const session = await studio.open(document)
                const summary = await studio.documents.ensure(document)
                request = {
                  uri: uri.toString(),
                  version: summary.version,
                  values: structuredClone(values ?? session.values),
                  outputs: structuredClone(session.outputs ?? []),
                  gridkit: gridkitOf(uri),
                  cacheBytes: cacheBytesOf(uri),
                }
                const info = await studio.client.call('prepareSimulation', request)
                request.simulationId = info.id
              }
              write.fire(`Simulation ${request.simulationId}, case version ${request.version}.\r\n`)
              subscription = studio.client.event.event((event) => {
                if (event.kind === 'log') {
                  if (!event.level && event.uri === request!.uri)
                    write.fire(event.message.replace(/\r?\n/g, '\r\n') + '\r\n')
                } else if (
                  !begun &&
                  event.info.state === 'running' &&
                  event.info.id === request!.simulationId
                ) {
                  begun = true
                  launch?.begun()
                }
              })
              if (cancelled) throw new Error('Task cancelled before launch.')
              await vscode.commands.executeCommand('gridkitStudio.monitor.focus', {
                preserveFocus: true,
              })
              if (cancelled) throw new Error('Task cancelled before launch.')
              if (!vscode.workspace.isTrusted)
                throw new Error('Trust this workspace to execute GridKit.')
              const result = await studio.client.call('run', request)
              write.fire(
                `\r\n${result.state}: ${result.frames} samples${result.message ? ' — ' + result.message : ''}\r\n`,
              )
              close.fire(result.state === 'complete' ? 0 : 1)
            })()
              .catch(async (error) => {
                if (request?.simulationId)
                  await studio.client
                    .call('stopSimulation', { simulationId: request.simulationId })
                    .catch(() => {})
                write.fire(message(error) + '\r\n')
                // A run that never began says why to whoever started it: Run, or the Tasks menu.
                if (!begun && !cancelled) {
                  if (found) launch?.failed(error)
                  else studio.report(error)
                }
                close.fire(1)
              })
              .finally(() => {
                subscription?.dispose()
                launch?.begun()
              })
          },
          close() {
            cancelled = true
            subscription?.dispose()
            launch?.begun()
            if (request?.simulationId)
              void studio.client
                .call('stopSimulation', { simulationId: request.simulationId })
                .catch(() => {})
          },
        }
        return terminal
      }),
      [],
    )
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Never,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    }
    return task
  }
  /** Whether `execution` is the task that runs the case at `uri`. */
  const runs = (execution: vscode.TaskExecution, uri: string) =>
    execution.task.definition.type === 'gridkit' && execution.task.definition.case === uri
  const provider = vscode.tasks.registerTaskProvider('gridkit', {
    provideTasks: () => [...studio.all.keys()].map((uri) => make(vscode.Uri.parse(uri))),
    resolveTask: (task) => {
      const path = task.definition.case
      if (typeof path !== 'string') return
      const folder =
        typeof task.scope === 'object' ? task.scope : vscode.workspace.workspaceFolders?.[0]
      return make(
        path.includes('://')
          ? vscode.Uri.parse(path)
          : vscode.Uri.file(resolve(folder?.uri.fsPath ?? '.', path)),
        task.definition.values && typeof task.definition.values === 'object'
          ? task.definition.values
          : undefined,
      )
    },
  })
  return {
    provider,
    active,
    /** Schedule an already accepted simulation. Its identity and snapshot are fixed. */
    async start(request: SimulationRequest) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
      if (!request.simulationId) throw new Error('Prepare the simulation before scheduling it.')
      if (launches.has(request.uri)) throw new Error('A simulation is already being scheduled.')
      const { launch, done } = track(request.uri)
      const ended = vscode.tasks.onDidEndTask(({ execution }) => {
        if (runs(execution, request.uri)) {
          void studio.client
            .call('stopSimulation', { simulationId: request.simulationId! })
            .catch(() => {})
          launch.begun()
        }
      })
      void done.catch((error) => studio.report(error)).finally(() => ended.dispose())
      try {
        await vscode.tasks.executeTask(
          make(vscode.Uri.parse(request.uri), undefined, structuredClone(request)),
        )
      } catch (error) {
        launch.failed(error)
        throw error
      }
    },
    /** Run the case at `uri`; resolves once GridKit's run begins, and rejects with why it could
     *  not. The run's own outcome shows in the Simulation view. */
    async simulate(uri: string, captured?: SimulationRequest) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
      if (active(uri)) throw new Error('A simulation is already active for this case.')
      if (captured) {
        if (captured.uri !== uri) throw new Error('Simulation targets a different case.')
      }
      const { launch, done } = track(uri)
      // A task that ends without opening its terminal never began.
      const ended = vscode.tasks.onDidEndTask(({ execution }) => {
        if (runs(execution, uri)) launch.begun()
      })
      vscode.tasks
        .executeTask(make(vscode.Uri.parse(uri), undefined, captured && structuredClone(captured)))
        .then(undefined, (error) => launch.failed(error))
      try {
        await done
      } finally {
        ended.dispose()
      }
    },
    /** Stop the case's run, or a run of it still starting. */
    async stop(uri: string) {
      if (launches.has(uri))
        for (const execution of vscode.tasks.taskExecutions)
          if (runs(execution, uri)) execution.terminate()
      await studio.client.call('stop', { uri })
    },
  }
}
export type Tasks = ReturnType<typeof registerTasks>
