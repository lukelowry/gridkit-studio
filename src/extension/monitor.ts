/** The Monitor's commands. It lists one monitor per recorded signal and shows one, or several
 *  split, as the Terminal lists terminals and shows one or a split group. */

import type { Id } from 'latkit'
import * as vscode from 'vscode'

import { randomUUID } from '../platform/crypto.js'
import { rm } from '../platform/files.js'
import { browser, tmpdir } from '../platform/host.js'
import { join, nameOf } from '../platform/path.js'
import { display } from '../shared/cells.js'
import { type Field, tableDefinition, tableLabel } from '../shared/document.js'
import { caseStem } from '../shared/format.js'
import type { Monitor, Summary } from '../shared/messages.js'
import { monitorName, monitorWith, sameField } from '../shared/monitors.js'
import { askRange, type Commands, type Context } from './commands.js'
import { exported, publish } from './exports.js'
import { reference } from './uris.js'

const TYPING_MS = 90

export function registerMonitor({ studio, command, focus, rows }: Commands) {
  /** Picks one of `monitors`, or the only one without asking. */
  const pickMonitor = async (summary: Summary, monitors: readonly Monitor[], title: string) => {
    if (monitors.length < 2) return monitors[0]
    const picked = await vscode.window.showQuickPick(
      monitors.map((monitor) => ({ label: monitorName(summary.definition, monitor), monitor })),
      { title },
    )
    return picked?.monitor
  }
  /** The monitor a command acts on: its menu's, else the first one shown. */
  const monitorOf = (context: Context): Monitor => {
    const { session, target } = context
    const field: Field | undefined = target?.monitor ?? session.shown[0]
    const monitor = field && session.monitors.find((each) => sameField(each, field))
    if (!monitor) throw new Error('The case records no signals.')
    return monitor
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

  // Shows the element's monitor in the Monitor, with the element selected so its trace stands out.
  command('revealInMonitor', async (context) => {
    const { session, element, field } = context
    if (!element) return
    const summary = await context.summary()
    const own = session.monitors.filter((monitor) => monitor.table === element.table)
    if (!own.length)
      throw new Error(`No ${tableLabel(summary.definition, element.table)} signal is recorded.`)
    const monitor =
      own.find((each) => field && sameField(each, field)) ??
      (await pickMonitor(summary, own, 'Reveal in Monitor'))
    if (!monitor) return
    session.showMonitor(monitor)
    await focus(session, 'monitor', element)
  })
  // Disabled in the manifest: a new monitor records another signal, which means writing the case's
  // mon lists, and Studio opens case files read-only.
  command('newMonitor', () => {
    throw new Error('Studio opens case files read-only, so it cannot record another signal.')
  })
  command('splitMonitor', async (context) => {
    const { session } = context
    const hidden = session.monitors.filter(
      (monitor) => !session.shown.some((each) => sameField(each, monitor)),
    )
    const monitor = context.target?.monitor
      ? monitorOf(context)
      : await pickMonitor(await context.summary(), hidden, 'Split Monitor')
    if (monitor) session.split(monitor)
  })
  command('unsplitMonitor', async (context) => {
    const { session } = context
    const monitor = context.target?.monitor
      ? monitorOf(context)
      : await pickMonitor(await context.summary(), session.shown, 'Unsplit Monitor')
    if (monitor) session.unsplit(monitor)
  })
  command('previousMonitor', ({ session }) => session.cycle(-1))
  command('nextMonitor', ({ session }) => session.cycle(1))
  command('chooseElement', async (context) => {
    const monitor = monitorOf(context)
    const id = await pickElement(await context.summary(), monitor.table, 'Every element')
    if (id !== undefined)
      context.session.setMonitor(monitorWith(monitor, id ?? undefined, monitor.range))
  })
  command('valueRange', async (context) => {
    const monitor = monitorOf(context)
    const { definition } = await context.summary()
    const range = await askRange(
      'Value Range of ' + monitorName(definition, monitor),
      monitor.range,
      'fits the values shown',
    )
    if (range !== undefined)
      context.session.setMonitor(monitorWith(monitor, monitor.id, range ?? undefined))
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
        exported(browser ? name : reference(uri))
      } finally {
        if (staged) await rm(path, { force: true })
      }
    } finally {
      studio.closeResults(shared)
    }
  })
  command('clearResults', ({ session }) => session.clear())
}
