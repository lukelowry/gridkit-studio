import type { ExtensionContext } from 'vscode'

import { registerCommands } from './commands.js'
import { Studio } from './studio.js'
import { registerViews } from './views.js'
import { workspaceAccess } from './workspace.js'
let studio: Studio | undefined
export function activate(context: ExtensionContext) {
  const started = performance.now()
  workspaceAccess()
  studio = new Studio(context)
  context.subscriptions.push(...registerViews(studio), ...registerCommands(studio))
  studio.reporter.output.info(
    `Activated in ${(performance.now() - started).toFixed(1)} ms; the worker starts on demand.`,
  )
  return { studio }
}
export async function deactivate() {
  await studio?.dispose()
  studio = undefined
}
