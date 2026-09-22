import * as vscode from 'vscode'

import type { Cases } from '../case.js'
import { command, uriOf } from '../commands.js'
import { bindColumns } from '../csv/columns.js'
import { CsvSource } from '../csv/source.js'

export function registerCsv(context: vscode.ExtensionContext, cases: Cases): void {
  command(context, 'openCsv', async (argument) => {
    let source: CsvSource | undefined
    try {
      const uri =
        uriOf(argument) ??
        (
          await vscode.window.showOpenDialog({
            title: 'Open Monitor CSV',
            filters: { 'Monitor or reference CSV': ['csv'] },
            canSelectMany: false,
          })
        )?.[0]
      if (!uri) return
      if (uri.scheme !== 'file')
        throw new Error('Open CSV files in a local, WSL, SSH, or Dev Container workspace.')
      const files = await vscode.workspace.findFiles('**/*.case.json', '**/{node_modules,.git}/**')
      const active = cases.active?.document.uri
      const choices = [
        ...new Map(
          [...(active ? [active] : []), ...files].map((uri) => [uri.toString(), uri]),
        ).values(),
      ]
      const choice = await vscode.window.showQuickPick(
        choices.map((uri) => ({
          label: vscode.workspace.asRelativePath(uri),
          description: uri.toString() === active?.toString() ? 'Active case' : undefined,
          uri,
        })),
        { title: 'Case for Monitor CSV' },
      )
      if (!choice) return
      const document = await vscode.workspace.openTextDocument(choice.uri)
      await cases.documents.ensureParsed(document)
      const state = cases.resolve(cases.get(document).target)
      if (!state) throw new Error('Fix the case errors before opening signals.')
      if (state.run?.status === 'running')
        throw new Error('Stop the simulation before opening another CSV for this case.')
      const target = state.target
      source = new CsvSource(uri.fsPath)
      const info = await source.scan(true)
      if (!info.rows) throw new Error('This CSV has no samples.')
      source.columns = bindColumns(state.raw, state.fields.model, info.headers, false)
      if (!state.current(target))
        throw new Error('The case changed while opening the CSV. Open it again.')
      await state.attachRun(undefined)
      await state.attachSource(source)
      source = undefined
      cases.focus(state)
      await vscode.commands.executeCommand('gridkitStudio.openMonitor')
    } finally {
      await source?.dispose()
    }
  })
}
