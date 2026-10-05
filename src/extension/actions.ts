import * as vscode from 'vscode'

import type { Element, Plot } from '../shared/messages.js'
import type { Session, Sessions } from './sessions.js'

/** Display an existing signal. Recording selections are intentionally a separate operation. */
export async function showPlot(studio: Sessions, session: Session, plot: Plot, element?: Element) {
  if (
    !session.plots.some(
      (item) => item.from === plot.from && item.field === plot.field && item.id === plot.id,
    )
  )
    session.plots.push(plot)
  await studio.persist(session)
  studio.changed.fire(session.uri)
  studio.activate(session.uri)
  if (element) studio.select(session.uri, element)
  await vscode.commands.executeCommand('gridkitStudio.monitor.focus')
}
