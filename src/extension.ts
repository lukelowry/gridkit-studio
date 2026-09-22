import * as vscode from 'vscode'

import { registerActions } from './actions.js'
import { Cases } from './case.js'
import { command, uriOf } from './commands.js'
import { caseContext } from './context.js'
import { Documents, isCase } from './documents.js'
import { MONITOR, MonitorView } from './monitor/view.js'
import { NETWORK, NetworkEditor } from './network/editor.js'
import { registerCsv } from './signals/open.js'
import { SignalsTree } from './signals/tree.js'
import { registerSimulationCommands } from './simulation/commands.js'
import { SIMULATION, SimulationView } from './simulation/view.js'
import { ElementStatus } from './status.js'
import { CaseTable, TABLE } from './table/view.js'
import { registerTasks } from './tasks.js'

let activeCases: Cases | undefined
export async function deactivate(): Promise<void> {
  await activeCases?.dispose()
  activeCases = undefined
}

export function activate(context: vscode.ExtensionContext): void {
  const documents = new Documents()
  const cases = (activeCases = new Cases(documents))
  const network = new NetworkEditor(context.extensionUri, cases)
  const table = new CaseTable(context.extensionUri, cases, context.workspaceState)
  const signals = new SignalsTree(cases, context)
  const simulation = new SimulationView(cases, context.extensionUri)
  const monitor = new MonitorView(context.extensionUri, cases, context)
  registerActions(context, cases, network, table, monitor)
  registerTasks(context, cases)
  registerSimulationCommands(context, cases, simulation)
  registerCsv(context, cases)
  context.subscriptions.push(
    caseContext(cases),
    documents,
    cases,
    network,
    table,
    signals,
    simulation,
    monitor,
    new ElementStatus(cases),
    vscode.window.registerWebviewViewProvider(TABLE, table),
    vscode.window.registerWebviewViewProvider(SIMULATION, simulation),
    vscode.window.registerWebviewViewProvider(MONITOR, monitor),
    vscode.window.registerCustomEditorProvider(NETWORK, network, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: false },
    }),
  )

  const active = () =>
    network.activeDocument?.uri ??
    vscode.window.activeTextEditor?.document.uri ??
    cases.active?.document.uri
  const pick = async () =>
    (
      await vscode.window.showOpenDialog({
        title: 'Open GridKit Case',
        openLabel: 'Open Case',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'GridKit cases (*.case.json)': ['json'] },
      })
    )?.[0]
  const open = async (uri: vscode.Uri) => {
    if (!isCase(uri)) throw new Error('Choose a GridKit .case.json file.')
    return vscode.workspace.openTextDocument(uri)
  }
  const showNetwork = async (uri: vscode.Uri) => {
    await open(uri)
    await vscode.commands.executeCommand('vscode.openWith', uri, NETWORK, {
      viewColumn: vscode.ViewColumn.Active,
      preview: false,
    })
  }
  const check = async (document: vscode.TextDocument) => {
    const snapshot = await documents.ensureParsed(document)
    if (snapshot.state === 'invalid') {
      void vscode.window.showErrorMessage(snapshot.issues[0].message)
      return
    }
    const { model } = snapshot.case
    const summary = {
      name: model.name,
      buses: model.topology.vertexCount,
      branches: model.topology.edges.length / 2,
    }
    void vscode.window.showInformationMessage(
      `${summary.name}: Buses: ${summary.buses}, branches: ${summary.branches}. Case structure checked.`,
    )
    return summary
  }
  command(context, 'openCase', async (argument) => {
    const target = uriOf(argument) ?? (await pick())
    if (target) await showNetwork(target)
  })
  command(context, 'validateCase', async (argument) => {
    const target = uriOf(argument) ?? active()
    if (target) return check(await open(target))
    void vscode.window.showInformationMessage(
      'Open a .case.json file with GridKit Studio: Open Case...',
    )
  })
  command(context, 'preview', async (argument) => {
    const target = uriOf(argument) ?? active() ?? (await pick())
    if (target) await showNetwork(target)
  })
  command(context, 'openTable', async (argument) => {
    const target = uriOf(argument) ?? active()
    if (target) await table.show(cases.get(await open(target)))
  })
  command(context, 'selectClass', () => table.selectClass())
  command(context, 'filterTable', () => table.filter())
  command(context, 'clearTableFilter', () => table.clearFilter())
  command(context, 'chooseColumns', () => table.chooseColumns())
  command(context, 'resetColumns', () => table.resetColumns())
  command(context, 'options', () => network.options())
  command(context, 'orbit', () => network.orbit())
  command(context, 'fit', () => network.fit())
  command(context, 'projection', () => network.projection())
  command(context, 'showSource', () => network.showSource())
}
