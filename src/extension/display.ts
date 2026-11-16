/** View commands: fit, reload, Network mappings, view settings and video or image export. */

import * as vscode from 'vscode'

import { type Field, leaf, networkRole } from '../shared/document.js'
import { settingsOf, viewId } from '../shared/ids.js'
import { CHANNELS, channelsFor, channelsOf, rangeOf } from '../shared/mappings.js'
import { mappingOf, type Target } from '../shared/menus.js'
import type { Summary } from '../shared/messages.js'
import { TILTED } from '../shared/settings.js'
import { askRange, type Commands, type Context } from './commands.js'
import { displayOf, setDisplay } from './settings.js'

export function registerDisplay({ studio, registrations, command, action, focus }: Commands) {
  /** The view a command acts on: its menu's view, else the active Network editor alone (title bar
   *  or Command Palette). */
  const canvasOf = (context: Context): { view?: Target['origin']; active: boolean } => {
    if (context.target) return { view: context.target.origin, active: false }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    return input instanceof vscode.TabInputCustom && input.viewType === viewId('network')
      ? { view: 'network', active: true }
      : { active: false }
  }
  command('fitAll', (context) => {
    const { view, active } = canvasOf(context)
    action(context, 'fitAll', view, active)
  })
  command('reloadView', (context) => {
    context.session.retry()
    action(context, 'reloadView')
  })

  /** The field in context, if a Network channel can show it. */
  const mappable = ({ field, session }: Context, summary: Summary): Field => {
    if (!field || !mappingOf(summary, session.mappings, field).mappable)
      throw new Error('Choose a number field of a type the Network draws.')
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
    // Height is only visible from the side, so tilt a flat Network as its Tilt button does.
    const uri = vscode.Uri.parse(session.uri)
    if (channels.includes('vertexHeight') && displayOf(uri)['network.tilt'] === 0)
      await setDisplay(uri, 'network.tilt', TILTED)
  })
  command('mappingRange', async (context) => {
    const { session } = context
    const field = mappable(context, await context.summary())
    const { mappings } = session
    const range = await askRange(
      'Mapping Range of ' + leaf(field.field),
      rangeOf(mappings, field),
      'measures the values shown',
    )
    if (range !== undefined) session.map(field, channelsOf(mappings, field), range ?? undefined)
  })
  command('removeMapping', ({ session, field }) => {
    if (field) session.map(field, [])
  })

  for (const [id, category] of [
    ['networkSettings', 'network'],
    ['monitorSettings', 'monitor'],
    ['exportSettings', 'export'],
  ] as const)
    registrations.push(
      studio.command(id, () =>
        vscode.commands.executeCommand('workbench.action.openSettings', settingsOf(category)),
      ),
    )
  // Shows the Export view, ready to export a video.
  command('exportVideo', async (context) => {
    await focus(context.session, 'export')
    action(context, 'exportVideo', 'export')
  })
  // The Network's title bar passes its file and a menu its target; the Monitor's title bar passes
  // nothing, which is why the Command Palette hides this command.
  command('exportImage', (context, value) => {
    const { view, active } =
      value instanceof vscode.Uri || context.target
        ? canvasOf(context)
        : { view: 'monitor' as const, active: false }
    action(context, 'exportImage', view, active)
  })
}
