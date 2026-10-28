/** Commands on a case and its elements: opening the case in its views, revealing an element in
 *  another, going where it refers, and editing, copying and deleting it. */

import * as vscode from 'vscode'

import { display, leaf } from '../shared/cells.js'
import {
  type Entity,
  entityLabel,
  fieldDefinition,
  fieldLabel,
  referenceFields,
} from '../shared/document.js'
import { viewId } from '../shared/ids.js'
import type { Value } from '../shared/messages.js'
import type { Commands, Context } from './context.js'

export function registerElements({
  studio,
  register,
  command,
  targetOf,
  focus,
  valuesOf,
  valueOf,
  referred,
  pickElement,
}: Commands) {
  register('openCase', async () => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit case': ['case.json'] },
      canSelectMany: false,
    })
    if (selected?.[0])
      await vscode.commands.executeCommand('vscode.openWith', selected[0], viewId('network'))
  })
  /** Opens the case in a canvas, selecting the element in context there. */
  const open = async (context: Context, kind: 'network' | 'diagram') => {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.parse(context.session.uri),
      viewId(kind),
      vscode.ViewColumn.Active,
    )
    if (context.element) context.session.select(context.element)
  }
  // A file's menu opens a view of the case; an element's reveals the element there.
  for (const id of ['openNetwork', 'revealInNetwork'] as const)
    command(id, (context) => open(context, 'network'))
  for (const id of ['openDiagram', 'revealInDiagram'] as const)
    command(id, (context) => open(context, 'diagram'))
  for (const id of ['openCasePanel', 'revealInCase'] as const)
    command(id, (context) => focus(context.session, 'case', context.element))
  command('openMonitor', (context) => focus(context.session, 'monitor', context.element))
  register('openSource', (value, supplied) =>
    studio.documents.reveal(targetOf(value, supplied).uri),
  )
  command('revealInSource', (context) =>
    studio.documents.reveal(context.session.uri, context.element),
  )
  // The element a reference of the element in context names: the field in context's, or, of an
  // element, the one of its references the user picks, when it has several.
  command('goToReference', async (context) => {
    const { session, summary, element, type, field } = context
    if (!element || !type) return
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
  command('editField', async (context) => {
    const { session, summary, element } = context
    if (!element) return
    const type = element.table
    const field =
      context.field ??
      (await vscode.window.showQuickPick(summary.editable[type] ?? [], {
        title: 'Edit ' + element.id,
      }))
    if (!field) return
    const spec = fieldDefinition(summary.definition, type, field)
    if (!spec || !summary.editable[type]?.includes(field))
      throw new Error(leaf(field) + ' cannot be edited.')
    const current = await valueOf(context, type, field, element.id)
    let value: Value
    if (spec.kind === 'reference' && spec.target) {
      const choice = await pickElement(context, spec.target)
      if (choice === undefined || choice === null) return
      value = choice
    } else if (spec.kind === 'boolean') {
      const choice = await vscode.window.showQuickPick(['true', 'false'], { title: field })
      if (!choice) return
      value = choice === 'true'
    } else {
      const text = await vscode.window.showInputBox({
        title: fieldLabel({ ...spec, label: field }),
        value: spec.kind === 'text' ? String(current ?? '') : JSON.stringify(current ?? null),
        validateInput: (input) => {
          if (spec.kind === 'text') return
          try {
            JSON.parse(input)
          } catch {
            return 'Enter a valid JSON value.'
          }
        },
      })
      if (text === undefined) return
      value = spec.kind === 'text' ? text : JSON.parse(text)
    }
    await studio.documents.edit(session.uri, summary.version, { ...element, field }, value)
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
  command('disconnectPort', async (context) => {
    if (!context.element || !context.field) return
    await studio.documents.transact(
      context.session.uri,
      context.summary.version,
      [{ kind: 'connect', from: { ...context.element, field: context.field }, to: null }],
      'Disconnect signal port',
    )
  })
  command('deleteElement', async (context) => {
    if (!context.element) return
    await studio.documents.transact(
      context.session.uri,
      context.summary.version,
      [{ kind: 'remove', entities: [context.element] }],
      'Delete element',
    )
  })
}
