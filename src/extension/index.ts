import type { ExtensionContext } from 'vscode'

import { catalogFile } from './catalog.js'
import { registerCommands } from './commands.js'
import { Reporter } from './report.js'
import { registerSignals } from './signals.js'
import { Studio } from './studio.js'
import { registerViews } from './views.js'
import { workspaceAccess } from './workspace.js'
let studio: Studio | undefined
export async function activate(context: ExtensionContext) {
  const started = performance.now()
  workspaceAccess()
  const reporter = new Reporter()
  studio = new Studio(context, await catalogFile((error) => reporter.report(error)), reporter)
  context.subscriptions.push(
    ...registerViews(studio),
    ...registerCommands(studio),
    ...registerSignals(studio),
  )
  studio.reporter.output.info(
    `Activated in ${(performance.now() - started).toFixed(1)} ms; the worker starts on demand.`,
  )
  return { studio }
}
export async function deactivate() {
  await studio?.dispose()
  studio = undefined
}
