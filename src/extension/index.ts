import type { ExtensionContext } from 'vscode'

import { registerAI } from './ai.js'
import { registerCommands } from './commands.js'
import { registerNavigation } from './navigation.js'
import { Sessions } from './sessions.js'
import { registerSignals } from './signals.js'
import { registerTrees } from './trees.js'
import { registerViews } from './views.js'
let studio: Sessions | undefined
export function activate(context: ExtensionContext) {
  const started = performance.now()
  studio = new Sessions(context)
  context.subscriptions.push(
    ...registerViews(studio),
    ...registerCommands(studio),
    ...registerTrees(studio),
    ...registerSignals(studio),
    ...registerNavigation(studio),
    ...registerAI(studio),
  )
  studio.output.info(
    `Activated in ${(performance.now() - started).toFixed(1)} ms; data worker starts on demand.`,
  )
  return { studio }
}
export async function deactivate() {
  await studio?.dispose()
  studio = undefined
}
