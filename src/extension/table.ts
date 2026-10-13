/** The Case panel's commands: the type it shows, its columns, its order and what filters its rows.
 *  What the panel shows is the session's, which every command here changes, the panel shown or
 *  not. Its title bar's type and name filter are VS Code's own pickers, in place of controls inside
 *  the panel. */

import * as vscode from 'vscode'

import { leaf, shownColumns, shownType, tableFields } from '../shared/cells.js'
import { typeName, unitOf } from '../shared/schema.js'
import type { Commands, Context } from './context.js'

export function registerTable({ command, valueOf }: Commands) {
  /** The type the Case panel shows, which its column commands change. */
  const shownOf = (context: Context) => {
    const type = shownType(context.summary, context.session.table)
    if (!type || !context.summary.schema.types[type])
      throw new Error('This case has no elements to show.')
    return type
  }
  command('chooseType', (context) => {
    const { schema, counts } = context.summary
    type Item = vscode.QuickPickItem & { type?: string }
    const items: Item[] = []
    let group: string | undefined
    for (const [type, count] of Object.entries(counts)) {
      if (!count) continue
      const description = schema.types[type]?.description ?? ''
      if (description !== group)
        items.push({ label: (group = description), kind: vscode.QuickPickItemKind.Separator })
      items.push({ label: typeName(schema, type), description: count.toLocaleString(), type })
    }
    const picker = vscode.window.createQuickPick<Item>()
    picker.title = 'Show in Case'
    picker.placeholder = 'Element type'
    picker.items = items
    const shown = shownType(context.summary, context.session.table)
    picker.activeItems = items.filter((item) => item.type === shown)
    picker.onDidAccept(() => {
      const type = picker.selectedItems[0]?.type
      if (type) context.session.setTable({ type })
      picker.hide()
    })
    picker.onDidHide(() => picker.dispose())
    picker.show()
  })
  // Live, as a filter box is: each keystroke filters, and Escape puts the old text back.
  command('filterRows', (context) => {
    const { session } = context
    const before = session.table.filter
    let kept = false
    const input = vscode.window.createInputBox()
    input.title = 'Filter ' + typeName(context.summary.schema, shownOf(context))
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
    const { schema } = context.summary
    const { table } = context.session
    const type = shownOf(context)
    const definitions = schema.types[type]!.fields
    const shown = shownColumns(context.summary, table, type)
    const selected = await vscode.window.showQuickPick(
      tableFields(context.summary, type).map((field) => ({
        label: leaf(field),
        description: [
          field.includes('.') ? field.slice(0, field.indexOf('.')) : '',
          unitOf(definitions[field], field),
        ]
          .filter(Boolean)
          .join(' · '),
        field,
        picked: shown.includes(field),
      })),
      { title: typeName(schema, type) + ' columns', canPickMany: true },
    )
    if (selected)
      context.session.setTable({
        columns: { ...table.columns, [type]: selected.map((item) => item.field) },
      })
  })
  command('resetColumns', (context) => {
    const { table } = context.session
    const type = shownOf(context)
    if (table.columns?.[type])
      context.session.setTable({
        columns: Object.fromEntries(
          Object.entries(table.columns).filter(([each]) => each !== type),
        ),
      })
  })
  command('hideColumn', (context) => {
    const type = shownOf(context)
    const { table } = context.session
    context.session.setTable({
      columns: {
        ...table.columns,
        [type]: shownColumns(context.summary, table, type).filter((each) => each !== context.field),
      },
    })
  })
  for (const [id, direction] of [
    ['sortAscending', 'ascending'],
    ['sortDescending', 'descending'],
  ] as const)
    command(id, (context) => {
      if (context.field) context.session.setTable({ order: { field: context.field, direction } })
    })
  command('clearSort', (context) => context.session.setTable({ order: undefined }))
  command('filterToValue', async (context) => {
    const { element, type, field } = context
    if (!element || !type || !field) return
    const value = await valueOf(context, type, field, element.id)
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')
      throw new Error(leaf(field) + ' holds no single value to filter by.')
    context.session.setTable({ type, equal: { field, value } })
  })
  command('clearFilter', (context) =>
    context.session.setTable({ filter: undefined, equal: undefined }),
  )
}
