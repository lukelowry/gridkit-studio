/** The Monitor's commands. Every signal picker offers the same signals: the outputs of the shown
 *  results, or, before there are any, the signals the case records. */

import type { Id } from 'latkit'
import * as vscode from 'vscode'

import { randomUUID } from '../platform/crypto.js'
import { rm } from '../platform/files.js'
import { browser, tmpdir } from '../platform/host.js'
import { join, nameOf } from '../platform/path.js'
import { display } from '../shared/cells.js'
import {
  type CaseDefinition,
  type Entity,
  fieldDefinition,
  tableDefinition,
  tableLabel,
} from '../shared/document.js'
import { caseStem } from '../shared/format.js'
import type { Plot, Summary } from '../shared/messages.js'
import { plotName, samePlot } from '../shared/plots.js'
import { askRange, type Commands, type Context } from './commands.js'
import { publish } from './exports.js'
import type { Session } from './session.js'
import { reference } from './uris.js'

const TYPING_MS = 90

/** The plottable signals, limited to `type` when given. */
function plottable(session: Session, summary: Summary, type?: string): Plot[] {
  const outputs = session.results?.outputs ?? []
  const offered = outputs.length
    ? outputs.map(({ table, field }) => ({ table, field }))
    : Object.entries(summary.recording.listed).flatMap(([table, fields]) =>
        Object.entries(fields).flatMap(([field, count]) => (count > 0 ? [{ table, field }] : [])),
      )
  return type === undefined ? offered : offered.filter(({ table }) => table === type)
}

const signalItem = (definition: CaseDefinition, plot: Plot) => ({
  label: plotName(definition, plot),
  detail: fieldDefinition(definition, plot.table, plot.field)?.label,
  plot,
})

export function registerPlots({ studio, command, focus, rows }: Commands) {
  /** Adds `plot` to the Monitor and shows it, selecting `element`. */
  const showPlot = (session: Session, plot: Plot, element?: Entity) => {
    session.addPlot(plot)
    return focus(session, 'monitor', element)
  }
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
  /** The plot a command acts on: the menu's plot, the only plot, or one the user picks. */
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
  /** Prompts for an element of `type` with live search. With `every`, the first item stands for
   *  every element and resolves null. */
  const pickElement = (
    summary: Summary,
    type: string,
    every?: string,
  ): Promise<Id | null | undefined> => {
    type Item = vscode.QuickPickItem & { id: Id | null }
    const picker = vscode.window.createQuickPick<Item>()
    picker.title = 'Choose ' + tableLabel(summary.definition, type)
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
            // Fetch every match; the picker scrolls.
            limit: Math.max(1, summary.counts[type] ?? 1),
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

  // Plots the field in context, or a picked signal, of the element in context alone.
  command('plotSignal', async (context) => {
    const { session, element, field } = context
    const summary = await context.summary()
    const signal =
      field && fieldDefinition(summary.definition, field.table, field.field)?.kind === 'sampled'
        ? field
        : await pickSignal(
            session,
            summary,
            element ? 'Plot Signal of ' + element.id : 'Plot Signal',
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
  // From the Monitor's title bar: a signal of every element.
  command('addPlot', async (context) => {
    const plot = await pickSignal(context.session, await context.summary(), 'Add Plot')
    if (plot) await showPlot(context.session, plot)
  })
  command('removePlot', async (context) => {
    const plot = await plotOf(context, 'Remove Plot')
    if (plot) context.session.removePlot(plot)
  })
  command('choosePlotElement', async (context) => {
    const plot = await plotOf(context, 'Choose Plot')
    if (!plot) return
    const id = await pickElement(await context.summary(), plot.table, 'Every element')
    if (id !== undefined) context.session.plotElement(plot, id ?? undefined)
  })
  command('valueRange', async (context) => {
    const plot = await plotOf(context, 'Choose Plot')
    if (!plot) return
    const { definition } = await context.summary()
    const range = await askRange(
      'Value Range of ' + plotName(definition, plot),
      plot.range,
      'fits the values shown',
    )
    if (range !== undefined) context.session.plotRange(plot, range ?? undefined)
  })
  command('timeWindow', async ({ session }) => {
    const range = await askRange(
      'Time Window [s]',
      session.window ?? session.results?.domain,
      'shows the whole run',
    )
    if (range !== undefined) session.setWindow(range ?? undefined)
  })

  command('openResults', async ({ session }) => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit results': ['csv'] },
      canSelectMany: false,
    })
    if (selected?.[0]) await session.load(reference(selected[0]))
  })
  command('exportCsv', async ({ session }) => {
    const { results } = session
    if (!results) throw new Error('There are no results to export.')
    // Share the results so they stay open while the user picks a destination.
    const shared = randomUUID()
    await studio.client.worker.call('share', { results: results.id, as: shared })
    try {
      const name = `${caseStem(nameOf(session.uri))}-results.csv`
      const uri = browser
        ? vscode.Uri.from({ scheme: 'opfs', path: '/' + name })
        : await vscode.window.showSaveDialog({
            title: 'Export CSV',
            defaultUri: vscode.Uri.joinPath(vscode.Uri.parse(session.uri), '..', name),
            filters: { CSV: ['csv'] },
          })
      if (!uri) return
      const staged = browser || uri.scheme !== 'file'
      const path = staged
        ? join(tmpdir(), 'gridkit-export-' + randomUUID() + '.csv')
        : reference(uri)
      try {
        await studio.client.worker.call('export', { results: shared, path })
        if (staged) await publish(path, uri)
      } finally {
        if (staged) await rm(path, { force: true })
      }
    } finally {
      studio.closeResults(shared)
    }
  })
  command('clearResults', ({ session }) => session.clear())
}
