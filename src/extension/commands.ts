/** Studio's commands, by what they act on: a case's elements, the Case panel's rows, the Monitor's
 *  plots and playback, and what the views draw. How each finds what it acts on is context.ts's. */

import { registerCanvases } from './canvases.js'
import { commandsOf } from './context.js'
import { registerElements } from './elements.js'
import { registerPlots } from './plots.js'
import type { Sessions } from './sessions.js'
import { registerTable } from './table.js'

export function registerCommands(studio: Sessions) {
  const commands = commandsOf(studio)
  registerElements(commands)
  registerTable(commands)
  registerPlots(commands)
  registerCanvases(commands)
  commands.register('showOutput', () => studio.reporter.output.show())
  return commands.registrations
}
