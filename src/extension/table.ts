/** The Case panel's commands: the type it shows, its columns, its order and what filters its rows.
 *  What the panel shows is the session's, which every command here changes, the panel shown or
 *  not. Its title bar's type and name filter are VS Code's own pickers, in place of controls inside
 *  the panel. */

import * as vscode from 'vscode'

import { shownColumns, shownType, tableFields } from '../shared/cells.js'
import { fieldDefinition, leaf, tableDefinition, tableLabel } from '../shared/document.js'
import type { Summary } from '../shared/messages.js'
import type { Commands, Context } from './commands.js'

export function registerTable({ command, valuesOf }: Commands) {
  /** The type the Case panel shows of the case `summary` describes, which its column commands
   *  change. */
  const shownOf = ({ session }: Context, summary: Summary) => {
    const type = shownType(summary, session.table)
    if (!type || !tableDefinition(summary.definition, type))
      throw new Error('This case has no elements to show.')
    return type
  }
  command('chooseType', async (context) => {
    const { session } = context
    const summary = await context.summary()
    const { definition, counts } = summary
    type Item = vscode.QuickPickItem & { type: string }
    const items: Item[] = Object.entries(counts)
      .filter(([, count]) => count)
      .map(([type, count]) => ({
        label: tableLabel(definition, type),
        description: count.toLocaleString(),
        type,
      }))
    const picker = vscode.window.createQuickPick<Item>()
    picker.title = 'Show in Case'
    picker.placeholder = 'Element type'
    picker.items = items
    const shown = shownType(summary, session.table)
    picker.activeItems = items.filter((item) => item.type === shown)
    picker.onDidAccept(() => {
      const type = picker.selectedItems[0]?.type
      if (type) session.setTable({ type })
      picker.hide()
    })
    picker.onDidHide(() => picker.dispose())
    picker.show()
  })
  // Live, as a filter box is: each keystroke filters, and Escape puts the old text back.
  command('filterRows', async (context) => {
    const { session } = context
    const summary = await context.summary()
    const before = session.table.filter
    let kept = false
    const input = vscode.window.createInputBox()
    input.title = 'Filter ' + tableLabel(summary.definition, shownOf(context, summary))
    input.prompt = 'Rows whose name contains'
    input.value = before ?? ''
    input.onDidChangeValue((filter) => session.setTable({ filter }))
    input.onDidAccept(() => {
      kept = true
      input.hide()
    })
    input.onDidHide(() => {
      if (!kept) session.setTable({ filter: before })
      input.dispose()
    })
    input.show()
  })
  command('chooseColumns', async (context) => {
    const { session } = context
    const summary = await context.summary()
    const { definition } = summary
    const { table } = session
    const type = shownOf(context, summary)
    const shown = shownColumns(summary, table, type)
    const selected = await vscode.window.showQuickPick(
      tableFields(summary, type).map((field) => ({
        label: leaf(field),
        description: [
          field.includes('.') ? field.slice(0, field.indexOf('.')) : '',
          fieldDefinition(definition, type, field)?.unit,
        ]
          .filter(Boolean)
          .join(' · '),
        field,
        picked: shown.includes(field),
      })),
      { title: tableLabel(definition, type) + ' columns', canPickMany: true },
    )
    if (selected)
      session.setTable({
        columns: { ...table.columns, [type]: selected.map((item) => item.field) },
      })
  })
  command('resetColumns', async (context) => {
    const { session } = context
    const { table } = session
    const type = shownOf(context, await context.summary())
    if (table.columns?.[type])
      session.setTable({
        columns: Object.fromEntries(
          Object.entries(table.columns).filter(([each]) => each !== type),
        ),
      })
  })
  command('hideColumn', async (context) => {
    const { session, field } = context
    const summary = await context.summary()
    const type = shownOf(context, summary)
    const { table } = session
    session.setTable({
      columns: {
        ...table.columns,
        [type]: shownColumns(summary, table, type).filter((each) => each !== field?.field),
      },
    })
  })
  for (const [id, direction] of [
    ['sortAscending', 'ascending'],
    ['sortDescending', 'descending'],
  ] as const)
    command(id, ({ session, field }) => {
      if (field) session.setTable({ order: { field: field.field, direction } })
    })
  command('clearSort', ({ session }) => session.setTable({ order: undefined }))
  command('filterToValue', async (context) => {
    const { session, element, field } = context
    if (!element || !field) return
    const summary = await context.summary()
    const value = (await valuesOf(summary, field.table, [field.field], element.id))[field.field]
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')
      throw new Error(leaf(field.field) + ' holds no single value to filter by.')
    session.setTable({ type: field.table, equal: { field: field.field, value } })
  })
  command('clearFilter', ({ session }) => session.setTable({ filter: undefined, equal: undefined }))
}
