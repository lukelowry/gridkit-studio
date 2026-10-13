import { randomUUID } from 'node:crypto'

import type { Block, Query, Schema } from '@latkit/model'
import * as vscode from 'vscode'

import {
  CHANNELS,
  channelsFor,
  channelsOf,
  domainOf,
  type FieldRef,
  NUMERIC,
} from '../shared/bindings.js'
import { display, leaf, rowsOf, shownColumns, shownType, tableFields } from '../shared/cells.js'
import type { Target } from '../shared/contexts.js'
import { type Command, settingsOf, viewId, viewOf } from '../shared/ids.js'
import {
  type Element,
  type Plot,
  revisionOf,
  type Summary,
  type Value,
  type ViewAction,
} from '../shared/messages.js'
import { plotName, samePlot } from '../shared/plots.js'
import {
  elementType,
  fieldName,
  fieldOf,
  networkOf,
  placementOf,
  typeName,
  unitOf,
} from '../shared/schema.js'
import type { LoopMode } from '../shared/transport.js'
import { reviewChanges } from './git.js'
import { noCase, SHOW_PROBLEMS } from './report.js'
import type { Session } from './session.js'
import type { Sessions } from './sessions.js'
import { choicesOf, choose } from './settings.js'

/** How long typing in a search rests before it searches. */
const TYPING_MS = 90
/** Simulated seconds per second a playhead can play at. */
const RATES = ['0.5', '1', '2', '4']

/** What a command acts on: its case, as it reads now, and the element and field it was invoked
 *  on. */
interface Context {
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
function localPath(uri: vscode.Uri): string {
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
/** Ask for a range, checked as it is typed; `empty` lets the box be left empty, which resolves to
 *  null. Undefined when cancelled. */
async function askRange(title: string, value?: string, empty?: string) {
  const text = await vscode.window.showInputBox({
    title,
    prompt: empty ? `Low and high values; empty ${empty}` : 'Low and high values',
    value,
    validateInput: (input) =>
      (empty && !input.trim()) || boundsOf(input) ? null : 'Two numbers, low then high',
  })
  return text === undefined ? undefined : (boundsOf(text) ?? null)
}

export function registerCommands(studio: Sessions) {
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
  /** Asks the views of the case in context to do `command`: those of one kind, or of the kind the
   *  menu was opened on. */
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
  const open = async (context: Context, kind: 'network' | 'diagram') => {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.parse(context.session.uri),
      viewId(kind),
      vscode.ViewColumn.Active,
    )
    if (context.element) context.session.select(context.element)
  }
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
  /** Shows `plot` in the Monitor of the session's case, with `element` selected. Recording is a
   *  separate choice, made in Monitored Signals. */
  const showPlot = (session: Session, plot: Plot, element?: Element) => {
    session.addPlot(plot)
    return focus(session, 'monitor', element)
  }
  const queryRows = async (context: Context, query: Query.Rows, signal?: AbortSignal) =>
    rowsOf(
      (await studio.client.cases.call(
        'query',
        { ...revisionOf(context.summary), query },
        signal,
      )) as Block.Rows[],
    )
  /** The stored value of `field` on the `type` element `id`. */
  const valueOf = async (context: Context, type: string, field: string, id: string) => {
    const [row] = await queryRows(context, {
      kind: 'rows',
      from: type,
      select: [field],
      ids: true,
      limit: 1,
      rows: { kind: 'ids', ids: [id] },
    })
    return row?.values[field]
  }
  /** The id of the row the reference `value` points to; throws `missing` when it points nowhere. */
  const referred = async (context: Context, value: unknown, missing: string) => {
    const reference = value as { index?: { type: string }; row?: number } | null
    if (!reference?.index || reference.row === undefined) throw new Error(missing)
    const [row] = await queryRows(context, {
      kind: 'rows',
      from: reference.index.type,
      select: [],
      rows: { kind: 'range', offset: reference.row, count: 1 },
      ids: true,
      limit: 1,
    })
    return row?.id
  }
  /** A signal as every picker shows it: named as its plot is, with what the catalog says of it. */
  const signalItem = (schema: Schema, plot: Plot) => ({
    label: plotName(schema, plot),
    detail: schema.types[plot.from]?.fields[plot.field]?.description,
    plot,
  })
  /** The recorded field in context, or one the user picks: of the element in context, or, from
   *  the Monitor, of any type. */
  const chooseSignal = async (
    context: Context,
  ): Promise<{ type: string; field: string } | undefined> => {
    const { schema, counts } = context.summary
    if (context.type && context.field && schema.types[context.type]?.fields[context.field]?.sampled)
      return { type: context.type, field: context.field }
    const own = context.target?.origin !== 'monitor' && context.element ? context.type : undefined
    const choice = await vscode.window.showQuickPick(
      Object.entries(schema.types)
        .filter(([type]) => own === undefined || type === own)
        .flatMap(([type, definition]) =>
          Object.entries(definition.fields)
            .filter(([, field]) => counts[type] && field.sampled)
            .map(([field]) => signalItem(schema, { from: type, field })),
        ),
      { title: own && context.element ? 'Plot a signal of ' + context.element.id : 'Plot signal' },
    )
    return choice && { type: choice.plot.from, field: choice.plot.field }
  }
  const pickPlot = async ({ session, summary }: Context, title: string) =>
    (
      await vscode.window.showQuickPick(
        session.plots.map((plot) => signalItem(summary.schema, plot)),
        { title },
      )
    )?.plot
  /** Search the `type` elements by name, or by exact id once the input starts with `type/`: every
   *  one that matches. */
  const pickReference = (context: Context, type: string): Promise<string | undefined> => {
    const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>()
    picker.title = 'Choose ' + type
    picker.placeholder = 'Search names or enter an exact ' + type + '/ID'
    picker.matchOnDescription = true
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
        const rows = await queryRows(
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
        picker.items = rows
          .filter((row) => row.id)
          .map((row) => ({
            label: name ? display(row.values[name]) : row.id!,
            description: row.id!,
            id: row.id!,
          }))
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
      picker.show()
      void update()
    })
  }
  register('openCase', async () => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit case': ['case.json'] },
      canSelectMany: false,
    })
    if (selected?.[0])
      await vscode.commands.executeCommand('vscode.openWith', selected[0], viewId('network'))
  })
  command('openNetwork', (context) => open(context, 'network'))
  command('reveal', (context) => open(context, 'network'))
  command('openDiagram', (context) => open(context, 'diagram'))
  command('revealDiagram', (context) => open(context, 'diagram'))
  command('openCasePanel', (context) => focus(context.session, 'case', context.element))
  command('showInCase', (context) => focus(context.session, 'case', context.element))
  command('openMonitor', (context) => focus(context.session, 'monitor', context.element))
  command('chooseSignals', ({ session }) => focus(session, 'signals'))
  register('showSource', (value, supplied) =>
    studio.documents.reveal(targetOf(value, supplied).uri),
  )
  command('elementSource', (context) =>
    studio.documents.reveal(context.session.uri, context.element),
  )
  command('validateCase', async (context) => {
    await studio.documents.validate(context.document)
    await vscode.commands.executeCommand(SHOW_PROBLEMS.command)
  })
  command('followReference', async (context) => {
    if (!context.element || !context.field || !context.type) return
    const id = await referred(
      context,
      await valueOf(context, context.type, context.field, context.element.id),
      'This reference is disconnected.',
    )
    if (id) context.session.select({ id })
  })
  command('editField', async (context) => {
    const { session, summary, element } = context
    if (!element) return
    const type = elementType(element.id)
    const field =
      context.field ??
      (await vscode.window.showQuickPick(summary.editable[type] ?? [], {
        title: 'Edit ' + element.id,
      }))
    if (!field) return
    const spec = summary.schema.types[type]?.fields[field]
    if (!spec || !summary.editable[type]?.includes(field))
      throw new Error(leaf(field) + ' cannot be edited.')
    const current = await valueOf(context, type, field, element.id)
    let value: Value
    if (typeof spec.type === 'object' && spec.type.kind === 'reference') {
      const choice = await pickReference(context, spec.type.to)
      if (!choice) return
      value = choice
    } else if (spec.type === 'boolean') {
      const choice = await vscode.window.showQuickPick(['true', 'false'], { title: field })
      if (!choice) return
      value = choice === 'true'
    } else {
      const text = await vscode.window.showInputBox({
        title: fieldName({ ...spec, label: field }, field),
        value: spec.type === 'text' ? String(current ?? '') : JSON.stringify(current ?? null),
        validateInput: (input) => {
          if (spec.type === 'text') return
          try {
            JSON.parse(input)
          } catch {
            return 'Enter a valid JSON value.'
          }
        },
      })
      if (text === undefined) return
      value = spec.type === 'text' ? text : JSON.parse(text)
    }
    await studio.documents.edit(session.uri, summary.version, { id: element.id, field }, value)
  })
  command('copyReference', async ({ element }) => {
    if (element) await vscode.env.clipboard.writeText(element.id)
  })
  command('copyValue', async (context) => {
    if (context.element && context.type && context.field)
      await vscode.env.clipboard.writeText(
        display(await valueOf(context, context.type, context.field, context.element.id)),
      )
  })
  onSession('clearResults', (session) => session.clear())
  const plot = async (context: Context) => {
    const selected = await chooseSignal(context)
    if (!selected) return
    // From the Monitor, plot the field of every element; elsewhere, of the element in context.
    const element = context.target?.origin === 'monitor' ? undefined : context.element
    const id = element?.id.startsWith(selected.type + '/') ? element.id : undefined
    const plot: Plot = { from: selected.type, field: selected.field, ...(id ? { id } : {}) }
    await showPlot(context.session, plot, context.element)
  }
  command('plot', plot)
  // From the Monitor's title: a signal the results on show hold, of every element.
  command('addPlot', async ({ summary, session }) => {
    const choice = await vscode.window.showQuickPick(
      (session.results?.outputs ?? []).flatMap(({ from, select }) =>
        select.map((field) => signalItem(summary.schema, { from, field })),
      ),
      { title: 'Add plot', placeHolder: 'A recorded signal, of every element' },
    )
    if (choice) await showPlot(session, choice.plot)
  })
  command('removePlot', async (context) => {
    const selected = context.target?.plot ?? (await pickPlot(context, 'Remove plot'))
    if (selected) context.session.removePlot(selected)
  })
  command('signalElements', async (context) => {
    // The session's own plot: a menu's target carries a copy of it.
    const target = context.target?.plot
    const plot = target
      ? context.session.plots.find((each) => samePlot(each, target))
      : context.session.plots.at(-1)
    if (!plot) return
    const id = await pickReference(context, plot.from)
    if (id) context.session.plotElement(plot, id)
  })
  // Any GridKit results file, read for the case as a run's own is.
  command('openResults', async (context) => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit results': ['csv'] },
      canSelectMany: false,
    })
    if (!selected?.[0]) return
    await context.session.load(localPath(selected[0]))
    await plot(context)
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
  register('showOutput', () => studio.reporter.output.show())
  command('performance', async (context) => {
    studio.reporter.output.appendLine(
      JSON.stringify({
        ...(await studio.client.stats()),
        parseMs: context.summary.parseMs,
      }),
    )
    studio.reporter.output.show()
  })
  onSession('toggleTimeline', ({ transport }) => transport.playPause())
  // To the head while frames arrive, else to the run's last sample.
  onSession('followTime', (session) => {
    const { transport } = session
    if (session.live) transport.goLive()
    else transport.seek(transport.state.span[1])
  })
  onSession('seekTime', async ({ transport }, value) => {
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
  onSession('loopTime', async ({ transport }) => {
    const loop = await vscode.window.showQuickPick<{ label: string; value: LoopMode }>(
      [
        { label: 'Once', value: 'none' },
        { label: 'Loop', value: 'wrap' },
        { label: 'Bounce', value: 'pingpong' },
      ],
      { title: 'Repeat playback' },
    )
    if (loop) transport.setLoop(loop.value)
  })
  onSession('timeSpeed', async ({ transport }) => {
    const rate = await vscode.window.showQuickPick(RATES, {
      title: 'Simulated seconds per second',
    })
    if (rate) transport.setRate(Number(rate))
  })
  command('orbit', (context) => action(context, 'orbit', undefined, 'network'))
  command('retryMonitor', (context) => {
    context.session.retry()
    action(context, 'retryMonitor', undefined, 'monitor')
  })
  /** The canvas a command acts on: the one its menu was opened on, else, from the editor's title
   *  bar, the one in front. */
  const canvasOf = (context: Context): Target['origin'] | undefined => {
    if (context.target) return context.target.origin
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const view = input instanceof vscode.TabInputCustom ? viewOf(input.viewType) : undefined
    return view === 'network' || view === 'diagram' ? view : undefined
  }
  command('fit', (context) => action(context, 'fit', undefined, canvasOf(context)))
  command('reloadView', (context) => action(context, 'reloadView', undefined, canvasOf(context)))
  // A neighborhood shows in a canvas, so from the Case panel the Network frames it.
  command('neighborhood', (context) => {
    if (!context.element) return
    context.session.select(context.element)
    action(
      context,
      'neighborhood',
      context.element.id,
      context.target?.origin === 'diagram' ? 'diagram' : 'network',
    )
  })
  onSession('resetMonitorWindow', (session) => {
    session.setWindow(undefined)
    studio.action.fire({ uri: session.uri, command: 'resetMonitorWindow', view: 'monitor' })
  })
  onSession('monitorWindow', async (session) => {
    const range = await askRange(
      'Time window [s]',
      (session.window ?? session.results?.domain)?.join(', '),
    )
    if (range) session.setWindow(range)
  })
  command('chooseOverlapping', async (context) => {
    const selected = await vscode.window.showQuickPick(
      (context.target?.items ?? []).map((element) => ({
        label: element.id,
        description: element.field,
        element,
      })),
      { title: 'Elements under the pointer' },
    )
    if (selected) context.session.select(selected.element)
  })
  /** The type the Case panel shows, which its column commands change. */
  const shownOf = (context: Context) => {
    const type = shownType(context.summary, context.session.table)
    if (!type || !context.summary.schema.types[type])
      throw new Error('This case has no elements to show.')
    return type
  }
  // What the Case panel shows is the session's, which every command here changes, the panel shown
  // or not.
  command('chooseColumns', async (context) => {
    const { schema } = context.summary
    const { table } = context.session
    const type = shownOf(context)
    const definitions = schema.types[type]!.fields
    const shown = shownColumns(context.summary, table, type)
    const selected = await vscode.window.showQuickPick(
      tableFields(context.summary, type).map((field) => ({
        label: leaf(field),
        description: [
          field.includes('.') ? field.slice(0, field.indexOf('.')) : '',
          unitOf(definitions[field], field),
        ]
          .filter(Boolean)
          .join(' · '),
        field,
        picked: shown.includes(field),
      })),
      { title: typeName(schema, type) + ' columns', canPickMany: true },
    )
    if (selected)
      context.session.setTable({
        columns: { ...table.columns, [type]: selected.map((item) => item.field) },
      })
  })
  command('resetColumns', (context) => {
    const { table } = context.session
    const type = shownOf(context)
    if (table.columns?.[type])
      context.session.setTable({
        columns: Object.fromEntries(
          Object.entries(table.columns).filter(([each]) => each !== type),
        ),
      })
  })
  // The Case panel's own view of its rows: its order, a value it is filtered to, its columns.
  for (const [id, direction] of [
    ['sortAscending', 'ascending'],
    ['sortDescending', 'descending'],
  ] as const)
    command(id, (context) => {
      if (context.field) context.session.setTable({ order: { field: context.field, direction } })
    })
  command('clearSort', (context) => context.session.setTable({ order: undefined }))
  command('hideColumn', (context) => {
    const type = shownOf(context)
    const { table } = context.session
    context.session.setTable({
      columns: {
        ...table.columns,
        [type]: shownColumns(context.summary, table, type).filter((each) => each !== context.field),
      },
    })
  })
  command('filterValue', async (context) => {
    const { element, type, field } = context
    if (!element || !type || !field) return
    const value = await valueOf(context, type, field, element.id)
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')
      throw new Error(leaf(field) + ' holds no single value to filter by.')
    context.session.setTable({ type, equal: { field, value } })
  })
  command('clearFilter', (context) =>
    context.session.setTable({ filter: undefined, equal: undefined }),
  )
  command('copyFieldPath', (context) => vscode.env.clipboard.writeText(context.field ?? ''))
  // The Case panel's type and name filter, from its title bar: VS Code's own pickers in place of
  // controls inside the panel.
  command('chooseType', (context) => {
    const { schema, counts } = context.summary
    type Item = vscode.QuickPickItem & { type?: string }
    const items: Item[] = []
    let group: string | undefined
    for (const [type, count] of Object.entries(counts)) {
      if (!count) continue
      const description = schema.types[type]?.description ?? ''
      if (description !== group)
        items.push({ label: (group = description), kind: vscode.QuickPickItemKind.Separator })
      items.push({ label: typeName(schema, type), description: count.toLocaleString(), type })
    }
    const picker = vscode.window.createQuickPick<Item>()
    picker.title = 'Show in Case'
    picker.placeholder = 'Element type'
    picker.items = items
    const shown = shownType(context.summary, context.session.table)
    picker.activeItems = items.filter((item) => item.type === shown)
    picker.onDidAccept(() => {
      const type = picker.selectedItems[0]?.type
      if (type) context.session.setTable({ type })
      picker.hide()
    })
    picker.onDidHide(() => picker.dispose())
    picker.show()
  })
  // Live, as a filter box is: each keystroke filters, and Escape puts the old text back.
  command('filterRows', (context) => {
    const { session } = context
    const before = session.table.filter
    let kept = false
    const input = vscode.window.createInputBox()
    input.title = 'Filter ' + typeName(context.summary.schema, shownOf(context))
    input.prompt = 'Rows whose name contains'
    input.value = before ?? ''
    input.onDidChangeValue((filter) => session.setTable({ filter }))
    input.onDidAccept(() => {
      kept = true
      input.hide()
    })
    input.onDidHide(() => {
      if (!kept) session.setTable({ filter: before })
      input.dispose()
    })
    input.show()
  })
  for (const [id, side] of [
    ['fromEndpoint', 0],
    ['toEndpoint', 1],
  ] as const)
    command(id, async (context) => {
      if (!context.element || !context.type) return
      const edge = networkOf(context.summary.schema).edges.find(
        (edge) => edge.type === context.type,
      )
      const field = edge?.ends?.[side]
      if (!field) return
      const target = await referred(
        context,
        await valueOf(context, context.type, field, context.element.id),
        'The endpoint is disconnected.',
      )
      if (target) context.session.select({ id: target })
    })
  // The title bar offers whichever is not the case now, so its icon shows whether the Diagram edits.
  for (const [id, editing] of [
    ['editDiagram', true],
    ['finishDiagramEditing', false],
  ] as const)
    command(id, (context) => {
      if (context.session.diagramEditing === editing) return
      context.session.setEditing(editing)
      action(context, 'diagramEditing', editing, 'diagram')
    })
  command('arrangeDiagram', (context) => action(context, 'arrangeDiagram', undefined, 'diagram'))
  command('projection', async (context) => {
    const value = await vscode.window.showQuickPick(['flat', 'tilt', 'globe'], {
      title: 'Network projection',
    })
    if (value) action(context, 'projection', value, 'network')
  })
  /** The numeric field in context, which a network channel can show. */
  const mappable = ({ summary, type, field }: Context): FieldRef => {
    if (!type || !field || !NUMERIC.has(fieldOf(summary.schema, type, field)?.type))
      throw new Error('Choose a numeric field to map.')
    return { type, field }
  }
  command('bind', async (context) => {
    const field = mappable(context)
    const { bindings } = context.session
    const current = channelsOf(bindings, field)
    const picked = await vscode.window.showQuickPick(
      channelsFor(placementOf(networkOf(context.summary.schema), field.type)).map((channel) => ({
        label: CHANNELS[channel].label,
        channel,
        picked: current.includes(channel),
      })),
      { title: 'Map ' + leaf(field.field), canPickMany: true },
    )
    if (picked)
      context.session.bind(
        field,
        picked.map(({ channel }) => channel),
        domainOf(bindings, field),
      )
  })
  command('mapRange', async (context) => {
    const field = mappable(context)
    const { bindings } = context.session
    const range = await askRange(
      'Mapping range of ' + leaf(field.field),
      domainOf(bindings, field)?.join(', ') ?? '',
      'measures the values shown',
    )
    if (range !== undefined)
      context.session.bind(field, channelsOf(bindings, field), range ?? undefined)
  })
  command('unbind', (context) => context.session.bind(mappable(context), []))
  command('signalRange', async (context) => {
    const { plots } = context.session
    const plot =
      context.target?.plot ??
      (plots.length === 1 ? plots[0] : await pickPlot(context, 'Choose plot'))
    if (!plot) return
    const range = await askRange('Plot value range')
    if (!range) return
    action(
      context,
      'signalRange',
      { plot: { from: plot.from, field: plot.field, ...(plot.id ? { id: plot.id } : {}) }, range },
      'monitor',
    )
  })
  command('colormap', async (context) => {
    const name = await vscode.window.showQuickPick(
      choicesOf('network.colormap').map(({ label, value }) => ({ label, value })),
      { title: 'Network colormap' },
    )
    if (name) await choose('network.colormap', name.value, vscode.Uri.parse(context.session.uri))
  })
  for (const [id, category] of [
    ['networkSettings', 'network'],
    ['diagramSettings', 'diagram'],
    ['monitorSettings', 'monitor'],
  ] as const)
    command(id, () =>
      vscode.commands.executeCommand('workbench.action.openSettings', settingsOf(category)),
    )
  command('disconnectPort', async (context) => {
    if (!context.element || !context.field) return
    await studio.documents.transact(
      context.session.uri,
      context.summary.version,
      [{ kind: 'connect', from: { id: context.element.id, field: context.field }, to: null }],
      'Disconnect signal port',
    )
  })
  command('deleteDiagramElement', async (context) => {
    if (!context.element) return
    await studio.documents.transact(
      context.session.uri,
      context.summary.version,
      [{ kind: 'remove', ids: [context.element.id] }],
      'Delete diagram element',
    )
  })
  command('reviewChanges', (context) => reviewChanges(vscode.Uri.parse(context.session.uri)))
  command('exportVideo', ({ session }) => focus(session, 'export'))
  return registrations
}
