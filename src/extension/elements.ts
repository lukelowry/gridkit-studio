/** Commands on a case and its elements: opening the case in its views, revealing an element in
 *  another, going where it refers, and editing, copying and deleting it. */

import * as vscode from 'vscode'

import { display, leaf } from '../shared/cells.js'
import { viewId } from '../shared/ids.js'
import type { Value } from '../shared/messages.js'
import { elementType, fieldName, referencesOf } from '../shared/schema.js'
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
    const definitions = summary.schema.types[type]?.fields ?? {}
    const fields = field ? [field] : referencesOf(summary.schema, type).map((each) => each.field)
    const values = await valuesOf(context, type, fields, element.id)
    const found = await Promise.all(
      fields.map(async (each) => ({ field: each, id: await referred(context, values[each]) })),
    )
    const targets = found.filter((each): each is { field: string; id: string } => !!each.id)
    if (!targets.length)
      throw new Error(
        field ? 'This reference is disconnected.' : `${element.id} refers to no element.`,
      )
    const target =
      targets.length === 1
        ? targets[0]
        : await vscode.window.showQuickPick(
            targets.map((each) => ({
              label: fieldName(definitions[each.field], each.field),
              description: each.id,
              ...each,
            })),
            { title: 'Elements ' + element.id + ' refers to' },
          )
    if (target) session.select({ id: target.id })
  })
  command('editField', async (context) => {
    const { session, summary, element } = context
    if (!element) return
    const type = elementType(element.id)
    const field =
      context.field ??
      (await vscode.window.showQuickPick(summary.editable[type] ?? [], {
        title: 'Edit ' + element.id,
      }))
    if (!field) return
    const spec = summary.schema.types[type]?.fields[field]
    if (!spec || !summary.editable[type]?.includes(field))
      throw new Error(leaf(field) + ' cannot be edited.')
    const current = await valueOf(context, type, field, element.id)
    let value: Value
    if (typeof spec.type === 'object' && spec.type.kind === 'reference') {
      const choice = await pickElement(context, spec.type.to)
      if (!choice) return
      value = choice
    } else if (spec.type === 'boolean') {
      const choice = await vscode.window.showQuickPick(['true', 'false'], { title: field })
      if (!choice) return
      value = choice === 'true'
    } else {
      const text = await vscode.window.showInputBox({
        title: fieldName({ ...spec, label: field }, field),
        value: spec.type === 'text' ? String(current ?? '') : JSON.stringify(current ?? null),
        validateInput: (input) => {
          if (spec.type === 'text') return
          try {
            JSON.parse(input)
          } catch {
            return 'Enter a valid JSON value.'
          }
        },
      })
      if (text === undefined) return
      value = spec.type === 'text' ? text : JSON.parse(text)
    }
    await studio.documents.edit(session.uri, summary.version, { id: element.id, field }, value)
  })
  command('copyId', async ({ element }) => {
    if (element) await vscode.env.clipboard.writeText(element.id)
  })
  command('copyValue', async (context) => {
    if (context.element && context.type && context.field)
      await vscode.env.clipboard.writeText(
        display(await valueOf(context, context.type, context.field, context.element.id)),
      )
  })
  // A Case panel column's, or a Recorded Signals field's.
  command('copyFieldPath', (context) => vscode.env.clipboard.writeText(context.field ?? ''))
  command('selectOverlapping', async (context) => {
    const selected = await vscode.window.showQuickPick(
      (context.target?.items ?? []).map((element) => ({
        label: element.id,
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
      [{ kind: 'connect', from: { id: context.element.id, field: context.field }, to: null }],
      'Disconnect signal port',
    )
  })
  command('deleteElement', async (context) => {
    if (!context.element) return
    await studio.documents.transact(
      context.session.uri,
      context.summary.version,
      [{ kind: 'remove', ids: [context.element.id] }],
      'Delete element',
    )
  })
}
