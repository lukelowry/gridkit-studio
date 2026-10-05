import { dirname, resolve } from 'node:path'

import * as vscode from 'vscode'

import type { GridKit, RunRequest } from '../shared/messages.js'
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

export function registerTasks(studio: Sessions) {
  const make = (uri: vscode.Uri, values?: Record<string, unknown>, captured?: RunRequest) => {
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
              const request: RunRequest = captured
                ? structuredClone(captured)
                : {
                    uri: uri.toString(),
                    version: summary.version,
                    values: structuredClone(values ?? session.values),
                    outputs: structuredClone(session.outputs ?? []),
                    gridkit: gridkitOf(uri),
                    cacheBytes: cacheBytesOf(uri),
                  }
              write.fire(
                `Captured ${document.isDirty ? 'unsaved ' : ''}case revision ${summary.version}.\r\n`,
              )
              subscription = studio.client.event.event((event) => {
                if (event.kind === 'log' && event.uri === request.uri)
                  write.fire(event.message.replace(/\r?\n/g, '\r\n') + '\r\n')
              })
              if (cancelled) throw new Error('Task cancelled before launch.')
              await vscode.commands.executeCommand('gridkitStudio.monitor.focus', {
                preserveFocus: true,
              })
              if (cancelled) throw new Error('Task cancelled before launch.')
              studio.documents.require(request)
              if (!vscode.workspace.isTrusted)
                throw new Error('Trust this workspace to execute GridKit.')
              started = true
              const result = await studio.client.call('run', request)
              write.fire(
                `\r\n${result.state}: ${result.frames} samples${result.message ? ' — ' + result.message : ''}\r\n`,
              )
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
    async run(uri: string, captured?: RunRequest) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
      if (studio.all.get(uri)?.run?.state === 'running')
        throw new Error('A simulation is already active for this case.')
      if (captured) {
        if (captured.uri !== uri) throw new Error('Run proposal targets a different case.')
        studio.documents.require(captured)
      }
      return vscode.tasks.executeTask(
        make(vscode.Uri.parse(uri), undefined, captured && structuredClone(captured)),
      )
    },
  }
}
export type Tasks = ReturnType<typeof registerTasks>
