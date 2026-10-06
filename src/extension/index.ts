import type { ExtensionContext } from 'vscode'

import { registerCommands } from './commands.js'
import { registerNavigation } from './navigation.js'
import { registerPlayback } from './playback.js'
import { Sessions } from './sessions.js'
import { registerSignals } from './signals.js'
import { registerTasks } from './tasks.js'
import { registerViews } from './views.js'
let studio: Sessions | undefined
export function activate(context: ExtensionContext) {
  const started = performance.now()
  studio = new Sessions(context)
  const tasks = registerTasks(studio)
  context.subscriptions.push(
    tasks.provider,
    ...registerViews(studio),
    ...registerCommands(studio, tasks),
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
