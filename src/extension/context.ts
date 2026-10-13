/** What every command of Studio's shares: how it finds the case, element and field it acts on, and
 *  what it asks of them. */

import type { Block, Query, Schema } from '@latkit/model'
import * as vscode from 'vscode'

import { display, rowsOf } from '../shared/cells.js'
import type { Target } from '../shared/contexts.js'
import type { Command } from '../shared/ids.js'
import {
  type Element,
  type Plot,
  revisionOf,
  type Summary,
  type ViewAction,
} from '../shared/messages.js'
import { plotName } from '../shared/plots.js'
import { elementType } from '../shared/schema.js'
import { noCase } from './report.js'
import type { Session } from './session.js'
import type { Sessions } from './sessions.js'

/** How long typing in a search rests before it searches. */
const TYPING_MS = 90

/** What a command acts on: its case, as it reads now, and the element and field it was invoked
 *  on. */
export interface Context {
  session: Session
  document: vscode.TextDocument
  summary: Summary
  target?: Target
  element?: Element
  type?: string
  field?: string
}
/** The case a webview's command is about. */
type Supplied = { uri?: string }

/** The file `uri` names on this machine; the results worker reads and writes files only there. */
export function localPath(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') throw new Error('Choose a file on this machine.')
  return uri.fsPath
}

/** `low, high` as a range: two finite numbers, low first, apart by a comma, spaces, or both. */
function boundsOf(text: string): [number, number] | undefined {
  const parts = text.trim().split(/\s*,\s*|\s+/)
  if (parts.length !== 2 || parts.includes('')) return undefined
  const [low, high] = parts.map(Number) as [number, number]
  return Number.isFinite(low) && Number.isFinite(high) && low < high ? [low, high] : undefined
}

/** Asks for a range, checked as it is typed, starting from `value`. Left empty, it is none, which
 *  `empty` says what it then shows. Undefined when cancelled. */
export async function askRange(
  title: string,
  value: readonly number[] | undefined,
  empty: string,
): Promise<[number, number] | null | undefined> {
  const text = await vscode.window.showInputBox({
    title,
    prompt: `Low and high values. Empty ${empty}.`,
    value: value?.join(', ') ?? '',
    validateInput: (input) =>
      !input.trim() || boundsOf(input) ? null : 'Two numbers, low then high',
  })
  return text === undefined ? undefined : (boundsOf(text) ?? null)
}

export type Commands = ReturnType<typeof commandsOf>

/** The way commands are made for `studio`, and what they ask of a case; the commands made with it
 *  are its `registrations`. */
export function commandsOf(studio: Sessions) {
  const registrations: vscode.Disposable[] = []
  /** The case and target an argument names: a native menu context, a webview target, or a case
   *  URI. */
  const targetOf = (value?: unknown, supplied?: Supplied) => {
    let target: Target | undefined
    if (value && typeof value === 'object' && 'gridkitTarget' in value)
      target = value.gridkitTarget as Target
    else if (
      value &&
      typeof value === 'object' &&
      'uri' in value &&
      typeof value.uri === 'string' &&
      'origin' in value
    )
      target = value as Target
    const uri =
      value instanceof vscode.Uri
        ? value.toString()
        : (target?.uri ?? supplied?.uri ?? studio.active)
    if (!uri) throw noCase()
    return { uri, target }
  }
  const resolve = async (value?: unknown, supplied?: Supplied): Promise<Context> => {
    const { uri, target } = targetOf(value, supplied)
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
    const session = studio.get(uri) ?? (await studio.open(document))
    const summary = await studio.documents.ensure(document)
    // A plot names a type's field, which an edit leaves as it was: the Monitor reads the results
    // against the revision they were opened at, so its menus are of that one.
    if (target && target.origin !== 'monitor' && target.version !== summary.version)
      throw new Error('The document changed. Open the context menu again.')
    // A menu acts on what it was opened on, and only that; any other command on the selection.
    const element = target ? target.element : session.selection
    return {
      session,
      document,
      summary,
      target,
      element,
      type: target?.type ?? (element && elementType(element.id)),
      field: target?.field ?? element?.field,
    }
  }
  const register = (id: Command, run: (value?: unknown, supplied?: Supplied) => unknown) =>
    registrations.push(studio.command(id, (value, supplied) => run(value, supplied as Supplied)))
  /** A command on the case in context, as it reads now. */
  const command = (id: Command, run: (context: Context, value?: unknown) => unknown) =>
    register(id, async (value, supplied) => run(await resolve(value, supplied), value))
  /** A command on the case's clock or results alone, which neither reads the case nor needs it to
   *  read: a key held down plays on while the case is edited, or broken. */
  const onSession = (id: Command, run: (session: Session, value?: unknown) => unknown) =>
    register(id, (value, supplied) => {
      const session = studio.get(targetOf(value, supplied).uri)
      if (!session) throw noCase()
      return run(session, value)
    })
  /** Asks the views of the case in context to do `command`: those of one kind, those of the kind
   *  the menu was opened on, or, with neither, all of them. */
  const action = (
    context: Context,
    command: ViewAction,
    value?: unknown,
    view?: Target['origin'],
  ) =>
    studio.action.fire({
      uri: context.session.uri,
      command,
      value,
      view: view ?? context.target?.origin,
    })
  /** Follows the case, and shows its `view`, selecting `element` there. */
  const focus = async (
    session: Session,
    view: Parameters<Sessions['showView']>[0],
    element?: Element,
  ) => {
    studio.activate(session.uri)
    if (element) session.select(element)
    await studio.showView(view)
  }
  const rows = async (context: Context, query: Query.Rows, signal?: AbortSignal) =>
    rowsOf(
      (await studio.client.cases.call(
        'query',
        { ...revisionOf(context.summary), query },
        signal,
      )) as Block.Rows[],
    )
  /** The stored values of `fields` on the `type` element `id`. */
  const valuesOf = async (context: Context, type: string, fields: string[], id: string) => {
    const [row] = await rows(context, {
      kind: 'rows',
      from: type,
      select: fields,
      ids: true,
      limit: 1,
      rows: { kind: 'ids', ids: [id] },
    })
    return row?.values ?? {}
  }
  /** The stored value of `field` on the `type` element `id`. */
  const valueOf = async (context: Context, type: string, field: string, id: string) =>
    (await valuesOf(context, type, [field], id))[field]
  /** The id of the element the reference `value` points to; undefined when it points nowhere. */
  const referred = async (context: Context, value: unknown) => {
    const reference = value as { index?: { type: string }; row?: number } | null
    if (!reference?.index || reference.row === undefined) return undefined
    const [row] = await rows(context, {
      kind: 'rows',
      from: reference.index.type,
      select: [],
      rows: { kind: 'range', offset: reference.row, count: 1 },
      ids: true,
      limit: 1,
    })
    return row?.id ?? undefined
  }
  /** A signal as every picker shows it: named as its plot is, with what the catalog says of it. */
  const signalItem = (schema: Schema, plot: Plot) => ({
    label: plotName(schema, plot),
    detail: schema.types[plot.from]?.fields[plot.field]?.description,
    plot,
  })
  /** One of the Monitor's plots, which the user picks. */
  const pickPlot = async ({ session, summary }: Context, title: string) =>
    (
      await vscode.window.showQuickPick(
        session.plots.map((plot) => signalItem(summary.schema, plot)),
        { title },
      )
    )?.plot
  /** Searches the `type` elements by name, or by exact id once the input starts with `type/`: the
   *  id of the one picked. With `every`, the first choice is every element, which picks null. */
  const pickElement = (
    context: Context,
    type: string,
    every?: string,
  ): Promise<string | null | undefined> => {
    type Item = vscode.QuickPickItem & { id: string | null }
    const picker = vscode.window.createQuickPick<Item>()
    picker.title = 'Choose ' + type
    picker.placeholder = 'Search names or enter an exact ' + type + '/ID'
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
      const name = context.summary.schema.types[type]?.fields.name ? 'name' : undefined
      try {
        const exact = picker.value.startsWith(type + '/')
        const found = await rows(
          context,
          {
            kind: 'rows',
            from: type,
            select: name ? [name] : [],
            ids: true,
            ...(exact
              ? { rows: { kind: 'ids', ids: [picker.value] } }
              : picker.value && name
                ? { where: [{ field: name, operator: 'contains', value: picker.value }] }
                : {}),
          },
          controller.signal,
        )
        if (current !== generation) return
        picker.items = [
          ...first,
          ...found
            .filter((row) => row.id)
            .map((row) => ({
              label: name ? display(row.values[name]) : row.id!,
              description: row.id!,
              id: row.id!,
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
  return {
    studio,
    registrations,
    targetOf,
    register,
    command,
    onSession,
    action,
    focus,
    rows,
    valuesOf,
    valueOf,
    referred,
    signalItem,
    pickPlot,
    pickElement,
  }
}
