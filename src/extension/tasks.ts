import { dirname, resolve } from 'node:path'

import * as vscode from 'vscode'

import type { GridKit, SimulationInfo, SimulationRequest } from '../shared/messages.js'
import type { Sessions } from './sessions.js'
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

/** The `resultCacheMiB` setting for `uri`, in bytes. */
export function cacheBytesOf(uri: vscode.Uri) {
  return (
    vscode.workspace.getConfiguration('gridkitStudio', uri).get<number>('resultCacheMiB', 256) *
    (1 << 20)
  )
}

/** A run being started: settled once GridKit's run begins, rejected with why it could not. */
interface Launch {
  /** Whether a run has taken it up: Start's own, or a task's from the Tasks menu. */
  claimed: boolean
  /** Whether it was stopped before GridKit's run began. */
  cancelled: boolean
  begun(): void
  failed(error: unknown): void
}

export function registerTasks(studio: Sessions) {
  /** The runs being started, by case. */
  const launches = new Map<string, Launch>()
  /** Track a run of the case at `uri` being started: its views say it is starting until GridKit's
   *  run begins. `done` settles then, or rejects with why the run could not begin. */
  const track = (uri: string) => {
    let launch!: Launch
    const done = new Promise<void>((resolve, reject) => {
      launch = {
        claimed: false,
        cancelled: false,
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

  /** Prepare and run the case at `uri` for `launch`, which hears once GridKit's run begins, or why
   *  it could not. The run's home is the Monitor, shown once as it starts without taking focus,
   *  and the Simulation view shows VS Code's own progress until it ends; nothing else opens.
   *  Resolves with how the run ended, or undefined for one that never began. */
  const execute = async (
    uri: vscode.Uri,
    launch: Launch,
    values?: Record<string, unknown>,
  ): Promise<SimulationInfo | undefined> => {
    let request: SimulationRequest | undefined
    let begun = false
    let subscription: vscode.Disposable | undefined
    const ran = (async () => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
      await showView('monitor')
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
      request.simulationId = (await studio.client.call('prepareSimulation', request)).id
      subscription = studio.client.event.event((event) => {
        if (
          event.kind === 'run' &&
          !begun &&
          event.info.state === 'running' &&
          event.info.id === request!.simulationId
        ) {
          begun = true
          launch.begun()
        }
      })
      if (launch.cancelled) throw new DOMException('Stopped before it began.', 'AbortError')
      return studio.client.call('run', request)
    })()
    void vscode.window.withProgress({ location: { viewId: 'gridkitStudio.simulation' } }, () =>
      ran.catch(() => undefined),
    )
    try {
      return await ran
    } catch (error) {
      if (request?.simulationId)
        await studio.client
          .call('stopSimulation', { simulationId: request.simulationId })
          .catch(() => {})
      // A run that never began says why to whoever started it, unless it was stopped.
      if (!begun) launch.failed(launch.cancelled ? undefined : error)
      return undefined
    } finally {
      subscription?.dispose()
      launch.begun()
    }
  }

  /** A run of the case at `uri` from the Tasks menu: the same run Start makes, which says what
   *  became of it where every run does, so its terminal only points there. */
  const make = (uri: vscode.Uri, values?: Record<string, unknown>) => {
    const task = new vscode.Task(
      { type: 'gridkit', case: uri.toString(), ...(values ? { values } : {}) },
      vscode.workspace.getWorkspaceFolder(uri) ?? vscode.TaskScope.Workspace,
      'Simulate ' + uri.path.split('/').at(-1),
      'GridKit',
      new vscode.CustomExecution(async () => {
        const write = new vscode.EventEmitter<string>()
        const close = new vscode.EventEmitter<number>()
        const key = uri.toString()
        let launch: Launch | undefined
        return {
          onDidWrite: write.event,
          onDidClose: close.event,
          open() {
            write.fire(
              `GridKit Studio runs ${uri.path.split('/').at(-1)}; its log is in Output › GridKit Studio.\r\n`,
            )
            if (active(key)) {
              studio.report(new Error('A simulation is already active for this case.'))
              close.fire(1)
              return
            }
            const tracked = track(key)
            launch = tracked.launch
            launch.claimed = true
            tracked.done.catch((error) => studio.report(error))
            void execute(uri, launch, values).then((info) =>
              close.fire(info?.state === 'complete' ? 0 : 1),
            )
          },
          close() {
            if (launch) launch.cancelled = true
            void studio.client.call('stop', { uri: key }).catch(() => {})
          },
        } satisfies vscode.Pseudoterminal
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
    /** Run the case at `uri` from Start, with no task or terminal; resolves once GridKit's run
     *  begins, and rejects with why it could not. */
    async simulate(uri: string) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
      if (active(uri)) throw new Error('A simulation is already active for this case.')
      const { launch, done } = track(uri)
      launch.claimed = true
      void execute(vscode.Uri.parse(uri), launch)
      await done
    },
    /** Stop the case's run, or a run of it still starting. */
    async stop(uri: string) {
      const launch = launches.get(uri)
      if (launch) launch.cancelled = true
      for (const execution of vscode.tasks.taskExecutions)
        if (execution.task.definition.type === 'gridkit' && execution.task.definition.case === uri)
          execution.terminate()
      await studio.client.call('stop', { uri })
    },
  }
}
export type Tasks = ReturnType<typeof registerTasks>
