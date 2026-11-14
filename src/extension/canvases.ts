/** Commands on what the views draw: framing and reloading them, mapping a field onto the Network,
 *  their settings, and a video or image of them. */

import * as vscode from 'vscode'

import { type Field, fieldDefinition, leaf, networkRole } from '../shared/document.js'
import { settingsOf, viewId } from '../shared/ids.js'
import { CHANNELS, channelsFor, channelsOf, NUMERIC, rangeOf } from '../shared/mappings.js'
import type { Target } from '../shared/menus.js'
import type { Summary } from '../shared/messages.js'
import { TILTED } from '../shared/settings.js'
import { askRange, type Commands, type Context } from './commands.js'
import { displayOf, setDisplay } from './settings.js'

export function registerCanvases({ studio, registrations, command, action, focus }: Commands) {
  /** The view a command acts on: the one its menu was opened on, else the Network in front alone,
   *  as its title bar or the Command Palette asks. */
  const canvasOf = (context: Context): { view?: Target['origin']; active: boolean } => {
    if (context.target) return { view: context.target.origin, active: false }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    return input instanceof vscode.TabInputCustom && input.viewType === viewId('network')
      ? { view: 'network', active: true }
      : { active: false }
  }
  command('fit', (context) => {
    const { view, active } = canvasOf(context)
    action(context, 'fit', undefined, view, active)
  })
  // Every view of the case, and its results, read and drawn again.
  command('reloadView', (context) => {
    context.session.retry()
    action(context, 'reloadView')
  })
  // A neighborhood shows in the Network, whatever menu asks: of the element, or, where the Network
  // does not draw it, of the elements nearest it.
  command('zoomToNeighborhood', async (context) => {
    const { session, element } = context
    if (!element) return
    session.select(element)
    const shown = await session.networkSelectionOf(element, await context.summary())
    action(context, 'neighborhood', shown, 'network')
  })

  /** The numeric field in context, which a network channel can show. */
  const mappable = ({ field }: Context, { definition }: Summary): Field => {
    if (!field || !NUMERIC.has(fieldDefinition(definition, field.table, field.field)?.kind))
      throw new Error('Choose a numeric field to map.')
    return field
  }
  command('mapTo', async (context) => {
    const { session } = context
    const summary = await context.summary()
    const field = mappable(context, summary)
    const { mappings } = session
    const current = channelsOf(mappings, field)
    const picked = await vscode.window.showQuickPick(
      channelsFor(networkRole(summary.definition, field.table)).map((channel) => ({
        label: CHANNELS[channel].label,
        channel,
        picked: current.includes(channel),
      })),
      { title: 'Map ' + leaf(field.field), canPickMany: true },
    )
    if (!picked) return
    const channels = picked.map(({ channel }) => channel)
    session.map(field, channels, rangeOf(mappings, field))
    // A height shows only from the side: a flat Network tilts, as its Tilt button tilts it.
    const uri = vscode.Uri.parse(session.uri)
    if (channels.includes('vertexHeight') && displayOf(uri)['network.tilt'] === 0)
      await setDisplay(uri, 'network.tilt', TILTED)
  })
  command('mappingRange', async (context) => {
    const { session } = context
    const field = mappable(context, await context.summary())
    const { mappings } = session
    const range = await askRange(
      'Mapping range of ' + leaf(field.field),
      rangeOf(mappings, field),
      'measures the values shown',
    )
    if (range !== undefined) session.map(field, channelsOf(mappings, field), range ?? undefined)
  })
  command('removeMapping', ({ session, field }) => {
    if (field) session.map(field, [])
  })

  // A view's settings are VS Code's own, with a case or without.
  for (const [id, category] of [
    ['networkSettings', 'network'],
    ['monitorSettings', 'monitor'],
  ] as const)
    registrations.push(
      studio.command(id, () =>
        vscode.commands.executeCommand('workbench.action.openSettings', settingsOf(category)),
      ),
    )
  command('exportVideo', ({ session }) => focus(session, 'export'))
  // The Network's title bar names its file, and a menu its view; the Monitor's title bar names
  // nothing, so the Command Palette leaves this out.
  command('exportImage', (context, value) => {
    const { view, active } =
      value instanceof vscode.Uri || context.target
        ? canvasOf(context)
        : { view: 'monitor' as const, active: false }
    action(context, 'exportImage', undefined, view, active)
  })
}
