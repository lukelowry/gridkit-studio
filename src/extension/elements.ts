/** Commands on a case and its elements: opening the case in its views, revealing an element in
 *  another or in the file, going where it refers, and copying it. */

import * as vscode from 'vscode'

import { display } from '../shared/cells.js'
import {
  entityLabel,
  fieldDefinition,
  fieldLabel,
  isEntity,
  referenceFields,
} from '../shared/document.js'
import { viewId } from '../shared/ids.js'
import type { Commands } from './commands.js'

export function registerElements({ studio, registrations, command, focus, valuesOf }: Commands) {
  registrations.push(
    studio.command('openCase', async () => {
      const selected = await vscode.window.showOpenDialog({
        filters: { 'GridKit case': ['case.json'] },
        canSelectMany: false,
      })
      if (selected?.[0])
        await vscode.commands.executeCommand('vscode.openWith', selected[0], viewId('network'))
    }),
  )
  // A file's menu opens the Network; an element's reveals the element there, or, where the Network
  // does not draw it, the elements nearest it.
  for (const id of ['openNetwork', 'revealInNetwork'] as const)
    command(id, async ({ session, element }) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.parse(session.uri),
        viewId('network'),
        vscode.ViewColumn.Active,
      )
      if (element) session.select(element)
    })
  for (const id of ['openCasePanel', 'revealInCase'] as const)
    command(id, ({ session, element }) => focus(session, 'case', element))
  command('openMonitor', ({ session }) => focus(session, 'monitor'))
  command('openSource', ({ session }) => studio.files.reveal(session.uri))
  // The element in the file, at its field when the field in context is one of its own.
  command('revealInSource', ({ session, element, field }) =>
    studio.files.reveal(
      session.uri,
      element && {
        ...element,
        ...(field?.table === element.table && { field: field.field }),
      },
    ),
  )
  // The element a reference of the element in context names: the field in context's, or, of an
  // element, the one of its references the user picks, when it has several.
  command('goToReference', async (context) => {
    const { session, element } = context
    if (!element) return
    const summary = await context.summary()
    const { definition } = summary
    const type = element.table
    // A field in context counts only as a reference: the cursor may rest on any.
    const named =
      context.field?.table === type &&
      fieldDefinition(definition, type, context.field.field)?.kind === 'reference'
        ? context.field.field
        : undefined
    const fields = named ? [named] : referenceFields(definition, type).map((each) => each.name)
    const values = await valuesOf(summary, type, fields, element.id)
    const targets = fields.flatMap((field) => {
      const id = values[field]
      return isEntity(id) ? [{ field, id }] : []
    })
    if (!targets.length)
      throw new Error(
        named ? 'This reference is disconnected.' : `${element.id} refers to no element.`,
      )
    const target =
      targets.length === 1
        ? targets[0]
        : await vscode.window.showQuickPick(
            targets.map((each) => ({
              label: fieldLabel(fieldDefinition(definition, type, each.field)!),
              description: entityLabel(each.id),
              ...each,
            })),
            { title: 'Elements ' + element.id + ' refers to' },
          )
    if (target) session.select(target.id)
  })
  command('copyId', async ({ element }) => {
    if (element) await vscode.env.clipboard.writeText(String(element.id))
  })
  command('copyValue', async (context) => {
    const { element, field } = context
    if (!element || !field) return
    const values = await valuesOf(await context.summary(), field.table, [field.field], element.id)
    await vscode.env.clipboard.writeText(display(values[field.field]))
  })
  // A Case panel column's, or a Monitored Signals field's.
  command('copyFieldPath', ({ field }) => vscode.env.clipboard.writeText(field?.field ?? ''))
  command('selectOverlapping', async ({ session, target }) => {
    const selected = await vscode.window.showQuickPick(
      (target?.items ?? []).map((element) => ({ label: entityLabel(element), element })),
      { title: 'Elements under the pointer' },
    )
    if (selected) session.select(selected.element)
  })
}
