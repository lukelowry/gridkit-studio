import type { ExtensionContext } from 'vscode'

import { registerCommands } from './commands.js'
import { registerNavigation } from './navigation.js'
import { registerPlayback } from './playback.js'
import { registerRuns } from './runs.js'
import { Sessions } from './sessions.js'
import { registerSignals } from './signals.js'
import { registerViews } from './views.js'
let studio: Sessions | undefined
export function activate(context: ExtensionContext) {
  const started = performance.now()
  studio = new Sessions(context)
  context.subscriptions.push(
    ...registerViews(studio),
    ...registerCommands(studio),
    ...registerRuns(studio),
    ...registerSignals(studio),
    ...registerNavigation(studio),
    ...registerPlayback(studio),
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
