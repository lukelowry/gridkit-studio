import { dirname, resolve } from 'node:path'

import * as vscode from 'vscode'

import type { RunRequest, RuntimeOptions } from './messages.js'
import type { Sessions } from './sessions.js'
export function registerTasks(studio: Sessions) {
  const make = (uri: vscode.Uri, values?: Record<string, unknown>) => {
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
        let subscription: vscode.Disposable | undefined
        let started = false
        let cancelled = false
        const terminal: vscode.Pseudoterminal = {
          onDidWrite: write.event,
          onDidClose: close.event,
          open() {
            void (async () => {
              if (!vscode.workspace.isTrusted)
                throw new Error('Trust this workspace to execute GridKit.')
              const document = await vscode.workspace.openTextDocument(uri)
              const session = await studio.open(document)
              const summary = await studio.documents.ensure(document)
              const settings = vscode.workspace.getConfiguration('gridkitStudio', uri)
              const runtime: RuntimeOptions = {
                method: settings.get('simulationMethod', 'auto'),
                executable: settings.get<string>('dynamicSimulationPath', '')
                  ? resolve(
                      vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? dirname(uri.fsPath),
                      settings.get<string>('dynamicSimulationPath')!,
                    )
                  : '',
                image: settings.get('containerImage', 'ghcr.io/lukelowry/gridkit:arrow'),
              }
              const request: RunRequest = {
                uri: uri.toString(),
                version: summary.version,
                values: structuredClone(values ?? session.values),
                outputs: session.outputs,
                runtime,
                cacheBytes: settings.get<number>('resultCacheMiB', 256) * (1 << 20),
              }
              write.fire(
                `Captured ${document.isDirty ? 'unsaved ' : ''}case revision ${summary.version}.\r\n`,
              )
              subscription = studio.client.event.event((event) => {
                if (event.kind === 'log' && event.uri === request.uri)
                  write.fire(event.message.replace(/\r?\n/g, '\r\n') + '\r\n')
              })
              if (cancelled) throw new Error('Task cancelled before launch.')
              started = true
              const result = await studio.client.call('run', request)
              write.fire(
                `\r\n${result.state}: ${result.frames} frames${result.message ? ' — ' + result.message : ''}\r\n`,
              )
              // The task's terminal took the panel; a run with results gives it to the Monitor.
              if (result.state === 'complete' && result.frames > 0)
                void vscode.commands.executeCommand('gridkitStudio.monitor.focus', {
                  preserveFocus: true,
                })
              close.fire(result.state === 'complete' ? 0 : 1)
            })()
              .catch((error) => {
                write.fire(String(error) + '\r\n')
                close.fire(1)
              })
              .finally(() => subscription?.dispose())
          },
          close() {
            cancelled = true
            subscription?.dispose()
            if (started) void studio.client.call('stop', { uri: uri.toString() }).catch(() => {})
          },
        }
        return terminal
      }),
      [],
    )
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
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
    async run(uri: string) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
      if (studio.all.get(uri)?.run?.state === 'running')
        throw new Error('A simulation is already active for this case.')
      return vscode.tasks.executeTask(make(vscode.Uri.parse(uri)))
    },
  }
}
