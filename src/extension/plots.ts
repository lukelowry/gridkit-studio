/** The Monitor's commands: what it plots and over which values and times, and the results it
 *  shows. Every picker of signals offers the same ones: those the results on show hold, or, before
 *  there are any, those the case records. */

import { randomUUID } from 'node:crypto'

import type { Id } from 'latkit'
import * as vscode from 'vscode'

import { display } from '../shared/cells.js'
import {
  type CaseDefinition,
  type Entity,
  fieldDefinition,
  tableDefinition,
  tableLabel,
} from '../shared/document.js'
import type { Plot, Summary } from '../shared/messages.js'
import { plotName, samePlot } from '../shared/plots.js'
import { askRange, type Commands, type Context } from './commands.js'
import type { Session } from './session.js'

/** How long typing in a search rests before it searches. */
const TYPING_MS = 90

/** The file `uri` names on this machine; the worker reads and writes files only there. */
function localPath(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') throw new Error('Choose a file on this machine.')
  return uri.fsPath
}

/** The signals there are to plot, of `type` alone when it is given. */
function plottable(session: Session, summary: Summary, type?: string): Plot[] {
  const outputs = session.results?.outputs ?? []
  const offered = outputs.length
    ? outputs.map(({ table, field }) => ({ table, field }))
    : Object.entries(summary.recording.listed).flatMap(([table, fields]) =>
        Object.entries(fields).flatMap(([field, count]) => (count > 0 ? [{ table, field }] : [])),
      )
  return type === undefined ? offered : offered.filter(({ table }) => table === type)
}

/** A plot as a picker lists it. */
const signalItem = (definition: CaseDefinition, plot: Plot) => ({
  label: plotName(definition, plot),
  detail: fieldDefinition(definition, plot.table, plot.field)?.label,
  plot,
})

export function registerPlots({ studio, command, focus, rows }: Commands) {
  /** Shows `plot` in the Monitor of the session's case, with `element` selected. What a run
   *  records is the case's own to say, in its records' `mon` lists. */
  const showPlot = (session: Session, plot: Plot, element?: Entity) => {
    session.addPlot(plot)
    return focus(session, 'monitor', element)
  }
  /** A signal the user picks, of `type` alone when it is given. */
  const pickSignal = async (session: Session, summary: Summary, title: string, type?: string) => {
    const { definition } = summary
    const offered = plottable(session, summary, type)
    if (!offered.length)
      throw new Error(
        `There is no ${type ? tableLabel(definition, type) + ' ' : ''}signal to plot.`,
      )
    return (
      await vscode.window.showQuickPick(
        offered.map((plot) => signalItem(definition, plot)),
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
    if (plots.length < 2) return plots[0]
    const { definition } = await context.summary()
    return (
      await vscode.window.showQuickPick(
        plots.map((plot) => signalItem(definition, plot)),
        { title },
      )
    )?.plot
  }
  /** Searches the `type` elements as the user types: the id of the one picked. With `every`, the
   *  first choice is every element, which picks null. */
  const pickElement = (
    summary: Summary,
    type: string,
    every?: string,
  ): Promise<Id | null | undefined> => {
    type Item = vscode.QuickPickItem & { id: Id | null }
    const picker = vscode.window.createQuickPick<Item>()
    picker.title = 'Choose ' + type
    picker.placeholder = 'Search names or IDs'
    picker.matchOnDescription = true
    const first: Item[] = every ? [{ label: every, id: null, alwaysShow: true }] : []
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const update = async () => {
      const current = ++generation
      controller?.abort()
      controller = new AbortController()
      picker.busy = true
      const name = tableDefinition(summary.definition, type)?.labelField
      try {
        const found = await rows(
          summary,
          {
            table: type,
            fields: name ? [name] : [],
            offset: 0,
            limit: 100,
            ...(picker.value ? { search: picker.value } : {}),
          },
          controller.signal,
        )
        if (current !== generation) return
        picker.items = [
          ...first,
          ...found.map((row) => ({
            label: name ? display(row.values[name]) : String(row.id),
            description: String(row.id),
            id: row.id,
          })),
        ]
      } catch (error) {
        if (!controller.signal.aborted) studio.reporter.report(error)
      } finally {
        if (current === generation) picker.busy = false
      }
    }
    return new Promise((resolve) => {
      const subscriptions = [
        picker.onDidChangeValue(() => {
          clearTimeout(timer)
          timer = setTimeout(() => void update(), TYPING_MS)
        }),
        picker.onDidAccept(() => {
          const selected = picker.selectedItems[0]
          if (selected) {
            resolve(selected.id)
            picker.hide()
          }
        }),
        picker.onDidHide(() => {
          resolve(undefined)
          controller?.abort()
          clearTimeout(timer)
          subscriptions.forEach((item) => item.dispose())
          picker.dispose()
        }),
      ]
      picker.items = first
      picker.show()
      void update()
    })
  }

  // The field in context, or one of the element in context the user picks, of that element alone.
  command('plotSignal', async (context) => {
    const { session, element, field } = context
    const summary = await context.summary()
    const signal =
      field && fieldDefinition(summary.definition, field.table, field.field)?.kind === 'sampled'
        ? field
        : await pickSignal(
            session,
            summary,
            element ? 'Plot a signal of ' + element.id : 'Plot signal',
            element?.table,
          )
    if (!signal) return
    const id = element?.table === signal.table ? element.id : undefined
    await showPlot(
      session,
      { table: signal.table, field: signal.field, ...(id !== undefined && { id }) },
      element,
    )
  })
  // From the Monitor's title: a signal of every element.
  command('addPlot', async (context) => {
    const plot = await pickSignal(context.session, await context.summary(), 'Add plot')
    if (plot) await showPlot(context.session, plot)
  })
  command('removePlot', async (context) => {
    const plot = await plotOf(context, 'Remove plot')
    if (plot) context.session.removePlot(plot)
  })
  command('choosePlotElement', async (context) => {
    const plot = await plotOf(context, 'Choose plot')
    if (!plot) return
    const id = await pickElement(await context.summary(), plot.table, 'Every element')
    if (id !== undefined) context.session.plotElement(plot, id ?? undefined)
  })
  command('valueRange', async (context) => {
    const plot = await plotOf(context, 'Choose plot')
    if (!plot) return
    const { definition } = await context.summary()
    const range = await askRange(
      'Value range of ' + plotName(definition, plot),
      plot.range,
      'fits the values shown',
    )
    if (range !== undefined) context.session.plotRange(plot, range ?? undefined)
  })
  command('timeWindow', async ({ session }) => {
    const range = await askRange(
      'Time window [s]',
      session.window ?? session.results?.domain,
      'shows the whole run',
    )
    if (range !== undefined) session.setWindow(range ?? undefined)
  })

  // Any GridKit results file, read for the case as a run's own is, and plotted as they are.
  command('openResults', async ({ session }) => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit results': ['csv'] },
      canSelectMany: false,
    })
    if (selected?.[0]) await session.load(localPath(selected[0]))
  })
  command('exportCsv', async ({ session }) => {
    const { results } = session
    if (!results) throw new Error('There are no results to export.')
    // Held while the user chooses where: results shown meanwhile take nothing from the export.
    const held = randomUUID()
    await studio.client.worker.call('share', { results: results.id, as: held })
    try {
      const path = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] } })
      if (path) await studio.client.worker.call('export', { results: held, path: localPath(path) })
    } finally {
      studio.closeResults(held)
    }
  })
  command('clearResults', ({ session }) => session.clear())
}
