/** Studio's commands: how each finds the case, element and field it acts on, what it may ask of
 *  them, and where each is made, by what it acts on. */

import type { Id } from 'latkit'
import * as vscode from 'vscode'

import { rowsOf } from '../shared/cells.js'
import { isRange, type TableRequest } from '../shared/data.js'
import type { Entity, Field } from '../shared/document.js'
import { type Command, followed } from '../shared/ids.js'
import type { Target } from '../shared/menus.js'
import { revisionOf, type Summary, type ViewAction } from '../shared/messages.js'
import { registerCanvases } from './canvases.js'
import { registerElements } from './elements.js'
import { registerPlayback } from './playback.js'
import { registerPlots } from './plots.js'
import { noCase } from './report.js'
import { registerRuns } from './runs.js'
import type { Session } from './session.js'
import type { Sessions } from './sessions.js'
import { registerTable } from './table.js'

/** What a command acts on: its case, and the element and field it was invoked on. A menu acts on
 *  what it was opened on, and only that; any other command on the selection. */
export interface Context {
  readonly session: Session
  /** What the menu the command was chosen from was opened on; none from a title bar, a key or the
   *  Command Palette. */
  readonly target?: Target
  readonly element?: Entity
  readonly field?: Field
  /** The case as its file reads now, for a command that needs it: one that does not read says so,
   *  and a menu opened on an earlier reading of it acts no more. */
  summary(): Promise<Summary>
}

/** `low, high` as a range: two finite numbers, low first, apart by a comma, spaces, or both. */
function rangeOf(text: string): [number, number] | undefined {
  const parts = text.trim().split(/\s*,\s*|\s+/)
  if (parts.includes('')) return undefined
  const range = parts.map(Number)
  return isRange(range) ? range : undefined
}

/** Asks for a range, checked as it is typed, starting from `value`. Left empty, it is none, which
 *  `empty` says what it then shows. Undefined when cancelled. */
export async function askRange(
  title: string,
  value: readonly [number, number] | undefined,
  empty: string,
): Promise<[number, number] | null | undefined> {
  const text = await vscode.window.showInputBox({
    title,
    prompt: `Low and high values. Empty ${empty}.`,
    value: value?.join(', ') ?? '',
    validateInput: (input) =>
      !input.trim() || rangeOf(input) ? null : 'Two numbers, low then high',
  })
  return text === undefined ? undefined : (rangeOf(text) ?? null)
}

export type Commands = ReturnType<typeof commandsOf>

/** The way commands are made for `studio`, and what they ask of a case; the commands made with it
 *  are its `registrations`. */
function commandsOf(studio: Sessions) {
  const registrations: vscode.Disposable[] = []
  /** What `value` names for a command to act on: a menu's target, a case file, or, with neither,
   *  the case the views follow. */
  const contextOf = (value: unknown): Context => {
    const target =
      value && typeof value === 'object' && 'gridkitTarget' in value
        ? (value.gridkitTarget as Target)
        : undefined
    // A file that is no case of Studio's names none: an editor's menu passes whatever file it shows.
    const named = value instanceof vscode.Uri ? value.toString() : target?.uri
    const uri = named !== undefined && followed(named) ? named : studio.active
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
        // A plot names a type's field, which a change of the file leaves as it was: the Monitor
        // reads the results against the revision they were opened at, so its menus are of that one.
        if (target && target.origin !== 'monitor' && target.version !== summary.version)
          throw new Error('The case file changed. Open the context menu again.')
        return summary
      },
    }
  }
  /** A command on the case in context: the one its menu or file names, else the one the views
   *  follow. One chosen from a menu opened on an earlier reading of the case refuses, whether or
   *  not it reads the case. */
  const command = (id: Command, run: (context: Context, value?: unknown) => unknown) =>
    registrations.push(
      studio.command(id, async (value) => {
        const context = contextOf(value)
        if (context.target && context.target.origin !== 'monitor') await context.summary()
        return run(context, value)
      }),
    )
  /** Asks the views of the case in context to do `command`: those of one kind, those of the kind
   *  the menu was opened on, or, with neither, all of them; with `active`, only the editor in
   *  front. */
  const action = (
    context: Context,
    command: ViewAction,
    value?: unknown,
    view?: Target['origin'],
    active = false,
  ) =>
    studio.action.fire({
      uri: context.session.uri,
      command,
      value,
      view: view ?? context.target?.origin,
      active,
    })
  /** Follows the case, and shows its `view`, selecting `element` there. */
  const focus = async (
    session: Session,
    view: Parameters<Sessions['showView']>[0],
    element?: Entity,
  ) => {
    studio.activate(session.uri)
    if (element) session.select(element)
    await studio.showView(view)
  }
  /** The rows of the case `summary` describes that `request` asks for. */
  const rows = async (summary: Summary, request: TableRequest, signal?: AbortSignal) =>
    rowsOf(
      await studio.client.worker.call('page', { revision: revisionOf(summary), request }, signal),
    )
  /** The values of `fields` the element `id` of `table` holds. */
  const valuesOf = async (summary: Summary, table: string, fields: string[], id: Id) => {
    const [row] = await rows(summary, { table, fields, ids: [id], offset: 0, limit: 1 })
    return row?.values ?? {}
  }
  return { studio, registrations, command, action, focus, rows, valuesOf }
}

export function registerCommands(studio: Sessions) {
  const commands = commandsOf(studio)
  registerElements(commands)
  registerTable(commands)
  registerPlots(commands)
  registerPlayback(commands)
  registerCanvases(commands)
  registerRuns(commands)
  commands.registrations.push(studio.command('showOutput', () => studio.reporter.output.show()))
  return commands.registrations
}
