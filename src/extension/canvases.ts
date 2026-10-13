/** Commands on what the views draw: framing and reloading them, editing the Diagram, mapping a
 *  field onto the Network, their settings, and a video of them. */

import * as vscode from 'vscode'

import {
  CHANNELS,
  channelsFor,
  channelsOf,
  domainOf,
  type FieldRef,
  NUMERIC,
} from '../shared/bindings.js'
import { leaf } from '../shared/cells.js'
import type { Target } from '../shared/contexts.js'
import { settingsOf, viewOf } from '../shared/ids.js'
import { fieldOf, networkOf, placementOf } from '../shared/schema.js'
import { askRange, type Commands, type Context } from './context.js'
import { openChanges } from './git.js'

export function registerCanvases({ command, action, focus }: Commands) {
  /** The canvas a command acts on: the one its menu was opened on, else, from the editor's title
   *  bar, the one in front. */
  const canvasOf = (context: Context): Target['origin'] | undefined => {
    if (context.target) return context.target.origin
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const view = input instanceof vscode.TabInputCustom ? viewOf(input.viewType) : undefined
    return view === 'network' || view === 'diagram' ? view : undefined
  }
  command('fit', (context) => action(context, 'fit', undefined, canvasOf(context)))
  // Every view of the case, and its results, read and drawn again.
  command('reloadView', (context) => {
    context.session.retry()
    action(context, 'reloadView')
  })
  // A neighborhood shows in a canvas, so from the Case panel the Network frames it.
  command('zoomToNeighborhood', (context) => {
    if (!context.element) return
    context.session.select(context.element)
    action(
      context,
      'neighborhood',
      context.element.id,
      context.target?.origin === 'diagram' ? 'diagram' : 'network',
    )
  })
  // The title bar offers whichever is not the case now, so its icon shows whether the Diagram edits.
  for (const [id, editing] of [
    ['editDiagram', true],
    ['finishDiagramEditing', false],
  ] as const)
    command(id, (context) => {
      if (context.session.diagramEditing === editing) return
      context.session.setEditing(editing)
      action(context, 'diagramEditing', editing, 'diagram')
    })
  command('arrangeDiagram', (context) => action(context, 'arrangeDiagram', undefined, 'diagram'))

  /** The numeric field in context, which a network channel can show. */
  const mappable = ({ summary, type, field }: Context): FieldRef => {
    if (!type || !field || !NUMERIC.has(fieldOf(summary.schema, type, field)?.type))
      throw new Error('Choose a numeric field to map.')
    return { type, field }
  }
  command('mapTo', async (context) => {
    const field = mappable(context)
    const { bindings } = context.session
    const current = channelsOf(bindings, field)
    const picked = await vscode.window.showQuickPick(
      channelsFor(placementOf(networkOf(context.summary.schema), field.type)).map((channel) => ({
        label: CHANNELS[channel].label,
        channel,
        picked: current.includes(channel),
      })),
      { title: 'Map ' + leaf(field.field), canPickMany: true },
    )
    if (picked)
      context.session.bind(
        field,
        picked.map(({ channel }) => channel),
        domainOf(bindings, field),
      )
  })
  command('mappingRange', async (context) => {
    const field = mappable(context)
    const { bindings } = context.session
    const range = await askRange(
      'Mapping range of ' + leaf(field.field),
      domainOf(bindings, field),
      'measures the values shown',
    )
    if (range !== undefined)
      context.session.bind(field, channelsOf(bindings, field), range ?? undefined)
  })
  command('removeMapping', (context) => context.session.bind(mappable(context), []))

  for (const [id, category] of [
    ['networkSettings', 'network'],
    ['diagramSettings', 'diagram'],
    ['monitorSettings', 'monitor'],
  ] as const)
    command(id, () =>
      vscode.commands.executeCommand('workbench.action.openSettings', settingsOf(category)),
    )
  command('openChanges', (context) => openChanges(vscode.Uri.parse(context.session.uri)))
  command('exportVideo', ({ session }) => focus(session, 'export'))
}
