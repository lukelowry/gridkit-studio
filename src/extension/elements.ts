/** Case and element commands: open the case's views, reveal an element in a view or the file, and
 *  copy ids and values. */

import * as vscode from 'vscode'

import { display } from '../shared/cells.js'
import { CASE_FILE, viewId } from '../shared/ids.js'
import type { Commands } from './commands.js'

function networkColumn(uri: string): vscode.ViewColumn | undefined {
  for (const group of vscode.window.tabGroups.all)
    for (const tab of group.tabs)
      if (
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === viewId('network') &&
        tab.input.uri.toString() === uri
      )
        return group.viewColumn
  return undefined
}

export function registerElements({ studio, registrations, command, focus, valuesOf }: Commands) {
  registrations.push(
    studio.command('openCase', async () => {
      // macOS matches only the last extension, so a `.case.json` filter would disable every case.
      const [selected] =
        (await vscode.window.showOpenDialog({
          filters: { 'GridKit case': ['json'] },
          canSelectMany: false,
        })) ?? []
      if (!selected) return
      if (!CASE_FILE.test(selected.path)) throw new Error('Choose a .case.json file.')
      await vscode.commands.executeCommand('vscode.openWith', selected, viewId('network'))
    }),
  )
  // Opens the Network, or brings an open one to the front, and selects the element in context.
  for (const id of ['openNetwork', 'revealInNetwork'] as const)
    command(id, async ({ session, element }) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.parse(session.uri),
        viewId('network'),
        networkColumn(session.uri) ?? vscode.ViewColumn.Active,
      )
      if (element) session.select(element)
    })
  for (const id of ['openCasePanel', 'revealInCasePanel'] as const)
    command(id, ({ session, element }) => focus(session, 'case', element))
  command('openMonitor', ({ session }) => focus(session, 'monitor'))
  // Opens the JSON at the element in context and its field, or at the start without an element.
  command('showJson', ({ session, element, field }) =>
    studio.files.reveal(
      session.uri,
      element && {
        ...element,
        ...(field?.table === element.table && { field: field.field }),
      },
    ),
  )
  command('copyId', async ({ element }) => {
    if (element) await vscode.env.clipboard.writeText(String(element.id))
  })
  command('copyValue', async (context) => {
    const { element, field } = context
    if (!element || !field) return
    const values = await valuesOf(await context.summary(), field.table, [field.field], element.id)
    await vscode.env.clipboard.writeText(display(values[field.field]))
  })
  command('copyFieldPath', ({ field }) => vscode.env.clipboard.writeText(field?.field ?? ''))
}
