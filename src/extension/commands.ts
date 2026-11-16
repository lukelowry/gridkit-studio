import type { Id } from 'latkit'
import * as vscode from 'vscode'

import { rowsOf } from '../shared/cells.js'
import { isRange, type TableRequest } from '../shared/data.js'
import type { Entity, Field } from '../shared/document.js'
import { formatNumber } from '../shared/format.js'
import { type Command, isCaseFile } from '../shared/ids.js'
import { type Target, targetOf } from '../shared/menus.js'
import { revisionOf, type Summary, type ViewAction, type ViewKind } from '../shared/messages.js'
import { registerDisplay } from './display.js'
import { registerElements } from './elements.js'
import { registerMonitor } from './monitor.js'
import { registerPlayback } from './playback.js'
import { noCase } from './report.js'
import { registerRuns } from './runs.js'
import type { Session } from './session.js'
import type { Studio } from './studio.js'
import { registerTable } from './table.js'

/** What a command acts on. A context menu command acts on its menu's target; any other command
 *  acts on the selection. */
export interface Context {
  readonly session: Session
  /** The context menu's target; absent from a title bar, a keybinding or the Command Palette. */
  readonly target?: Target
  readonly element?: Entity
  readonly field?: Field
  /** The case's current summary. Throws if the case does not read, or if a menu opened on an
   *  older version is now out of date. */
  summary(): Promise<Summary>
}

/** Parses `low, high`: two finite numbers, low first, separated by a comma, spaces or both. */
function parseRange(text: string): [number, number] | undefined {
  const parts = text.trim().split(/\s*,\s*|\s+/)
  if (parts.includes('')) return undefined
  const range = parts.map(Number)
  return isRange(range) ? range : undefined
}

/** Prompts for a range starting from `value`. Returns null when left empty (`empty` describes what
 *  that means) and undefined when cancelled. */
export async function askRange(
  title: string,
  value: readonly [number, number] | undefined,
  empty: string,
): Promise<[number, number] | null | undefined> {
  const text = await vscode.window.showInputBox({
    title,
    prompt: `Low and high values. Empty ${empty}.`,
    value: value?.map(formatNumber).join(', ') ?? '',
    validateInput: (input) =>
      !input.trim() || parseRange(input) ? null : 'Two numbers, low then high',
  })
  return text === undefined ? undefined : (parseRange(text) ?? null)
}

export type Commands = ReturnType<typeof commandsOf>

/** Helpers for registering commands on `studio`; registered commands collect in `registrations`. */
function commandsOf(studio: Studio) {
  const registrations: vscode.Disposable[] = []
  const contextOf = (value: unknown): Context => {
    const target = targetOf(value)
    // An editor menu passes whatever file it shows, which may not be a case.
    const named = value instanceof vscode.Uri ? value.toString() : target?.uri
    const uri = named !== undefined && isCaseFile(named) ? named : studio.active
    if (!uri) throw noCase()
    const session = studio.get(uri) ?? studio.activate(uri)
    const selected = target ? undefined : session.selection
    return {
      session,
      target,
      element: target ? target.element : selected && { table: selected.table, id: selected.id },
      field: target
        ? target.field
        : selected?.field === undefined
          ? undefined
          : { table: selected.table, field: selected.field },
      async summary() {
        const summary = await studio.files.readable(uri)
        // Monitor menus are exempt: the Monitor reads results against the revision they were
        // opened at, and a plot's field survives file changes.
        if (target && target.origin !== 'monitor' && target.version !== summary.version)
          throw new Error('The case file changed. Open the context menu again.')
        return summary
      },
    }
  }
  /** Registers a command on its context's case. A command from a menu opened on an older version
   *  of the case refuses to run. */
  const command = (id: Command, run: (context: Context, value?: unknown) => unknown) =>
    registrations.push(
      studio.command(id, async (value) => {
        const context = contextOf(value)
        if (context.target && context.target.origin !== 'monitor') await context.summary()
        return run(context, value)
      }),
    )
  /** Sends `command` to the case's views of kind `view`, else of the menu's kind, else all of
   *  them; with `active`, only the active editor. */
  const action = (context: Context, command: ViewAction, view?: ViewKind, active = false) =>
    studio.action.fire({
      uri: context.session.uri,
      command,
      view: view ?? context.target?.origin,
      active,
    })
  const focus = async (
    session: Session,
    view: Parameters<Studio['showView']>[0],
    element?: Entity,
  ) => {
    studio.activate(session.uri)
    if (element) session.select(element)
    await studio.showView(view)
  }
  const rows = async (summary: Summary, request: TableRequest, signal?: AbortSignal) =>
    rowsOf(
      await studio.client.worker.call('page', { revision: revisionOf(summary), request }, signal),
    )
  const valuesOf = async (summary: Summary, table: string, fields: string[], id: Id) => {
    const [row] = await rows(summary, { table, fields, ids: [id], offset: 0, limit: 1 })
    return row?.values ?? {}
  }
  return { studio, registrations, command, action, focus, rows, valuesOf }
}

export function registerCommands(studio: Studio) {
  const commands = commandsOf(studio)
  registerElements(commands)
  registerTable(commands)
  registerMonitor(commands)
  registerPlayback(commands)
  registerDisplay(commands)
  registerRuns(commands)
  commands.registrations.push(studio.command('showOutput', () => studio.reporter.output.show()))
  return commands.registrations
}
