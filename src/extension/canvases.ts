/** Commands on what the views draw: framing and reloading them, mapping a field onto the Network,
 *  their settings, and a video or image of them. */

import * as vscode from 'vscode'

import {
  CHANNELS,
  channelsFor,
  channelsOf,
  domainOf,
  type FieldRef,
  NUMERIC,
} from '../shared/bindings.js'
import type { Target } from '../shared/contexts.js'
import { fieldDefinition, leaf, networkRole } from '../shared/document.js'
import { settingsOf, viewOf } from '../shared/ids.js'
import { TILTED } from '../shared/preferences.js'
import { askRange, type Commands, type Context } from './context.js'
import { displayOf, setDisplay } from './settings.js'

export function registerCanvases({ command, action, focus }: Commands) {
  /** The view a command acts on: the one its menu was opened on, else the Network in front alone,
   *  as its title bar or the Command Palette asks. */
  const canvasOf = (context: Context): { view?: Target['origin']; active: boolean } => {
    if (context.target) return { view: context.target.origin, active: false }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const view = input instanceof vscode.TabInputCustom ? viewOf(input.viewType) : undefined
    return view === 'network' ? { view, active: true } : { active: false }
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
    const { session, summary, element } = context
    if (!element) return
    session.select(element)
    action(context, 'neighborhood', await session.drawnFor(element, summary), 'network')
  })

  /** The numeric field in context, which a network channel can show. */
  const mappable = ({ summary, type, field }: Context): FieldRef => {
    if (!type || !field || !NUMERIC.has(fieldDefinition(summary.definition, type, field)?.kind))
      throw new Error('Choose a numeric field to map.')
    return { table: type, field }
  }
  command('mapTo', async (context) => {
    const field = mappable(context)
    const { bindings } = context.session
    const current = channelsOf(bindings, field)
    const picked = await vscode.window.showQuickPick(
      channelsFor(networkRole(context.summary.definition, field.table)).map((channel) => ({
        label: CHANNELS[channel].label,
        channel,
        picked: current.includes(channel),
      })),
      { title: 'Map ' + leaf(field.field), canPickMany: true },
    )
    if (!picked) return
    const channels = picked.map(({ channel }) => channel)
    context.session.bind(field, channels, domainOf(bindings, field))
    // A height shows only from the side: a flat Network tilts, as its Tilt button tilts it.
    const uri = vscode.Uri.parse(context.session.uri)
    if (channels.includes('vertexHeight') && displayOf(uri)['network.tilt'] === 0)
      await setDisplay(uri, 'network.tilt', TILTED)
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
    ['monitorSettings', 'monitor'],
  ] as const)
    command(id, () =>
      vscode.commands.executeCommand('workbench.action.openSettings', settingsOf(category)),
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
