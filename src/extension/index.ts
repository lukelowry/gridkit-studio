import type { ExtensionContext } from 'vscode'

import { registerAI } from './ai/index.js'
import { registerCommands } from './commands.js'
import { registerNavigation } from './navigation.js'
import { registerPlayback } from './playback.js'
import { Sessions } from './sessions.js'
import { registerSignals } from './signals.js'
import { registerTasks } from './tasks.js'
import { registerViews } from './views.js'
let studio: Sessions | undefined
let ai: ReturnType<typeof registerAI> | undefined
export function activate(context: ExtensionContext) {
  const started = performance.now()
  studio = new Sessions(context)
  const tasks = registerTasks(studio)
  ai = registerAI(studio, tasks)
  context.subscriptions.push(
    ai,
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
  return { studio, mcp: ai.mcp }
}
export async function deactivate() {
  await ai?.dispose()
  ai = undefined
  await studio?.dispose()
  studio = undefined
}
