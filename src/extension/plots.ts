/** The Monitor's commands: what it plots and over which values and times, the results it shows,
 *  and their playback. Every picker of signals offers the same ones: those the results on show
 *  hold, or, before there are any, those the case records. */

import { randomUUID } from 'node:crypto'

import * as vscode from 'vscode'

import { formatNumber } from '../shared/format.js'
import type { Element, Plot } from '../shared/messages.js'
import { plotName, samePlot } from '../shared/plots.js'
import { typeName } from '../shared/schema.js'
import { RATES } from '../shared/transport.js'
import { askRange, type Commands, type Context, localPath } from './context.js'
import { CHOOSE_SIGNALS, notice } from './report.js'
import type { Session } from './session.js'

/** The signals there are to plot, of `type` alone when it is given. */
function plottable({ session, summary }: Context, type?: string): Plot[] {
  const outputs = session.results?.outputs ?? []
  const offered = outputs.length
    ? outputs.flatMap(({ from, select }) => select.map((field) => ({ from, field })))
    : Object.entries(summary.recording.listed).flatMap(([from, fields]) =>
        Object.entries(fields).flatMap(([field, count]) => (count > 0 ? [{ from, field }] : [])),
      )
  return type === undefined ? offered : offered.filter(({ from }) => from === type)
}

export function registerPlots({
  studio,
  command,
  onSession,
  action,
  focus,
  signalItem,
  pickPlot,
  pickElement,
}: Commands) {
  /** Shows `plot` in the Monitor of the session's case, with `element` selected. Recording is a
   *  separate choice, made in Monitored Signals. */
  const showPlot = (session: Session, plot: Plot, element?: Element) => {
    session.addPlot(plot)
    return focus(session, 'monitor', element)
  }
  /** A signal the user picks, of `type` alone when it is given. */
  const pickSignal = async (context: Context, title: string, type?: string) => {
    const { schema } = context.summary
    const offered = plottable(context, type)
    if (!offered.length)
      throw notice(
        `There is no ${type ? typeName(schema, type) + ' ' : ''}signal to plot.`,
        CHOOSE_SIGNALS,
      )
    return (
      await vscode.window.showQuickPick(
        offered.map((plot) => signalItem(schema, plot)),
        { title },
      )
    )?.plot
  }
  /** The plot a command acts on: the one its menu was opened on, the only one, or one the user
   *  picks. */
  const plotOf = async (context: Context, title: string) => {
    const { plots } = context.session
    const target = context.target?.plot
    if (target) return plots.find((each) => samePlot(each, target))
    return plots.length === 1 ? plots[0] : await pickPlot(context, title)
  }

  // The field in context, or one of the element in context the user picks, of that element alone.
  command('plotSignal', async (context) => {
    const { summary, element, type, field } = context
    const signal =
      type && field && summary.schema.types[type]?.fields[field]?.sampled
        ? { from: type, field }
        : await pickSignal(
            context,
            element ? 'Plot a signal of ' + element.id : 'Plot signal',
            element && type,
          )
    if (!signal) return
    const id = element?.id.startsWith(signal.from + '/') ? element.id : undefined
    await showPlot(
      context.session,
      { from: signal.from, field: signal.field, ...(id && { id }) },
      element,
    )
  })
  // From the Monitor's title: a signal of every element.
  command('addPlot', async (context) => {
    const plot = await pickSignal(context, 'Add plot')
    if (plot) await showPlot(context.session, plot)
  })
  command('removePlot', async (context) => {
    const plot = await plotOf(context, 'Remove plot')
    if (plot) context.session.removePlot(plot)
  })
  command('choosePlotElement', async (context) => {
    const plot = await plotOf(context, 'Choose plot')
    if (!plot) return
    const id = await pickElement(context, plot.from, 'Every element')
    if (id !== undefined) context.session.plotElement(plot, id ?? undefined)
  })
  command('valueRange', async (context) => {
    const plot = await plotOf(context, 'Choose plot')
    if (!plot) return
    const range = await askRange(
      'Value range of ' + plotName(context.summary.schema, plot),
      undefined,
      'fits the values shown',
    )
    if (range === undefined) return
    const { from, field, id } = plot
    action(context, 'valueRange', { plot: { from, field, ...(id && { id }) }, range }, 'monitor')
  })
  onSession('timeWindow', async (session) => {
    const range = await askRange(
      'Time window [s]',
      session.window ?? session.results?.domain,
      'shows the whole run',
    )
    if (range !== undefined) session.setWindow(range ?? undefined)
  })

  // Any GridKit results file, read for the case as a run's own is, and plotted as they are.
  command('openResults', async (context) => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit results': ['csv'] },
      canSelectMany: false,
    })
    if (selected?.[0]) await context.session.load(localPath(selected[0]))
  })
  onSession('exportCsv', async ({ results }) => {
    if (!results) throw new Error('There are no results to export.')
    // Held while the user chooses where: results shown meanwhile take nothing from the export.
    const held = randomUUID()
    await studio.client.results.call('share', { results: results.id, as: held })
    try {
      const path = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] } })
      if (path) await studio.client.results.call('export', { results: held, path: localPath(path) })
    } finally {
      studio.closeResults(held)
    }
  })
  onSession('clearResults', (session) => session.clear())

  onSession('playPause', ({ transport }) => transport.playPause())
  // To the head while frames arrive, else to the run's last sample.
  onSession('goToEnd', (session) => {
    const { transport } = session
    if (session.live) transport.goLive()
    else transport.seek(transport.state.span[1])
  })
  onSession('goToTime', async ({ transport }, value) => {
    if (transport.state.status === 'idle') return
    const text =
      typeof value === 'number'
        ? String(value)
        : await vscode.window.showInputBox({
            title: 'Time [s]',
            value: String(transport.currentT()),
            validateInput: (input) =>
              input.trim() && Number.isFinite(Number(input)) ? null : 'A finite time',
          })
    if (text === undefined) return
    transport.pause()
    transport.seek(Number(text))
  })
  for (const [id, direction] of [
    ['previousSample', -1],
    ['nextSample', 1],
  ] as const)
    onSession(id, (session) => session.step(direction))
  onSession('playbackSpeed', async ({ transport }) => {
    const chosen = await vscode.window.showQuickPick(
      RATES.map((rate) => ({ label: formatNumber(rate) + '×', rate })),
      { title: 'Playback speed', placeHolder: 'Simulated seconds per second' },
    )
    if (chosen) transport.setRate(chosen.rate)
  })
}
