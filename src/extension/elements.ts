/** Commands on a case and its elements: opening the case in its views, revealing an element in
 *  another or in the file, going where it refers, and copying it. */

import * as vscode from 'vscode'

import { display } from '../shared/cells.js'
import {
  type Entity,
  entityLabel,
  fieldDefinition,
  fieldLabel,
  referenceFields,
} from '../shared/document.js'
import { viewId } from '../shared/ids.js'
import type { Commands } from './context.js'

export function registerElements({
  studio,
  register,
  command,
  targetOf,
  focus,
  valuesOf,
  valueOf,
  referred,
}: Commands) {
  register('openCase', async () => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit case': ['case.json'] },
      canSelectMany: false,
    })
    if (selected?.[0])
      await vscode.commands.executeCommand('vscode.openWith', selected[0], viewId('network'))
  })
  // A file's menu opens the Network; an element's reveals the element there, or, where the Network
  // does not draw it, the elements nearest it.
  for (const id of ['openNetwork', 'revealInNetwork'] as const)
    command(id, async (context) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.parse(context.session.uri),
        viewId('network'),
        vscode.ViewColumn.Active,
      )
      if (context.element) context.session.select(context.element)
    })
  for (const id of ['openCasePanel', 'revealInCase'] as const)
    command(id, (context) => focus(context.session, 'case', context.element))
  command('openMonitor', (context) => focus(context.session, 'monitor', context.element))
  register('openSource', (value, supplied) => studio.files.reveal(targetOf(value, supplied).uri))
  command('revealInSource', (context) => studio.files.reveal(context.session.uri, context.element))
  // The element a reference of the element in context names: the field in context's, or, of an
  // element, the one of its references the user picks, when it has several.
  command('goToReference', async (context) => {
    const { session, summary, element, type } = context
    if (!element || !type) return
    // A field in context counts only as a reference: the cursor may rest on any.
    const field =
      context.field &&
      fieldDefinition(summary.definition, type, context.field)?.kind === 'reference'
        ? context.field
        : undefined
    const fields = field
      ? [field]
      : referenceFields(summary.definition, type).map((each) => each.name)
    const values = await valuesOf(context, type, fields, element.id)
    const found = await Promise.all(
      fields.map(async (each) => ({ field: each, id: referred(values[each]) })),
    )
    const targets = found.filter((each): each is { field: string; id: Entity } => !!each.id)
    if (!targets.length)
      throw new Error(
        field ? 'This reference is disconnected.' : `${element.id} refers to no element.`,
      )
    const target =
      targets.length === 1
        ? targets[0]
        : await vscode.window.showQuickPick(
            targets.map((each) => ({
              label: fieldLabel(fieldDefinition(summary.definition, type, each.field)!),
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
    if (context.element && context.type && context.field)
      await vscode.env.clipboard.writeText(
        display(await valueOf(context, context.type, context.field, context.element.id)),
      )
  })
  // A Case panel column's, or a Monitored Signals field's.
  command('copyFieldPath', (context) => vscode.env.clipboard.writeText(context.field ?? ''))
  command('selectOverlapping', async (context) => {
    const selected = await vscode.window.showQuickPick(
      (context.target?.items ?? []).map((element) => ({
        label: entityLabel(element),
        description: element.field,
        element,
      })),
      { title: 'Elements under the pointer' },
    )
    if (selected) context.session.select(selected.element)
  })
}
