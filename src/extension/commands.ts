import type { RowsBlock, RowsQuery, Value } from '@latkit/model'
import * as vscode from 'vscode'

import {
  CHANNELS,
  channelsFor,
  channelsOf,
  domainOf,
  type FieldRef,
  NUMERIC,
} from '../shared/bindings.js'
import { display, leaf, rowsOf } from '../shared/cells.js'
import type { Target } from '../shared/contexts.js'
import { detail } from '../shared/format.js'
import type { Element, Plot, Summary } from '../shared/messages.js'
import { definitions } from '../shared/preferences.js'
import { elementType, networkOf, placementOf, typeName } from '../shared/schema.js'
import type { LoopMode } from '../shared/transport.js'
import { showPlot } from './actions.js'
import { reviewChanges } from './git.js'
import type { Session, Sessions } from './sessions.js'
import { cacheBytesOf, type Tasks } from './tasks.js'

/** What a command acts on: its case, and the element and field it was invoked on. */
interface Context {
  session: Session
  summary: Summary
  target?: Target
  element?: Element
  type?: string
  field?: string
}
/** The case a webview's command is about. */
type Supplied = { uri?: string }
/** The file `uri` names on this machine; the data worker reads and writes files only there. */
function localPath(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') throw new Error('Choose a file on this machine.')
  return uri.fsPath
}
/** `low, high` as a mapping range: two finite numbers, low first. */
function rangeOf(text: string): [number, number] | undefined {
  const [low, high, ...rest] = text.split(',').map((value) => Number(value.trim()))
  return !rest.length && Number.isFinite(low) && Number.isFinite(high) && low! < high!
    ? [low!, high!]
    : undefined
}

export function registerCommands(studio: Sessions, tasks: Tasks) {
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
    if (!uri) throw new Error('Open a GridKit case first.')
    return { uri, target }
  }
  const resolve = async (value?: unknown, supplied?: Supplied): Promise<Context> => {
    const { uri, target } = targetOf(value, supplied)
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
    const session = studio.all.get(uri) ?? (await studio.open(document))
    const summary = await studio.documents.ensure(document)
    if (target && target.version !== summary.version)
      throw new Error('The document changed. Open the context menu again.')
    const element =
      target?.element ??
      (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
        ? (value as Element)
        : session.selection)
    return {
      session,
      summary,
      target,
      element,
      type: target?.type ?? (element && elementType(element.id)),
      field: target?.field ?? element?.field,
    }
  }
  const register = (id: string, run: (value?: unknown, supplied?: Supplied) => unknown) =>
    registrations.push(
      studio.command('gridkitStudio.' + id, (value, supplied) => run(value, supplied as Supplied)),
    )
  const command = (id: string, run: (context: Context, value?: unknown) => unknown) =>
    register(id, async (value, supplied) => run(await resolve(value, supplied), value))
  const changed = (session: Session) => {
    studio.persist(session)
    studio.changed.fire(session.uri)
  }
  const action = (context: Context, command: string, value?: unknown, view?: string) =>
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
      'gridkitStudio.' + kind,
      vscode.ViewColumn.Active,
    )
    if (context.element) studio.select(context.session.uri, context.element)
  }
  /** Activate the case and focus its `view` panel, selecting `element` there. */
  const focus = async (session: Session, view: string, element?: Element) => {
    studio.activate(session.uri)
    if (element) studio.select(session.uri, element)
    await vscode.commands.executeCommand('gridkitStudio.' + view + '.focus')
  }
  const queryRows = async (context: Context, query: RowsQuery, signal?: AbortSignal) =>
    rowsOf(
      (await studio.client.call(
        'query',
        { uri: context.session.uri, version: context.summary.version, query },
        signal,
      )) as RowsBlock[],
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
  /** The recorded field in context, or one the user picks. */
  const chooseSignal = async (
    context: Context,
  ): Promise<{ type: string; field: string } | undefined> => {
    const { schema, counts } = context.summary
    if (context.type && context.field && schema.types[context.type]?.fields[context.field]?.sampled)
      return { type: context.type, field: context.field }
    const choice = await vscode.window.showQuickPick(
      Object.entries(schema.types).flatMap(([type, definition]) =>
        Object.entries(definition.fields)
          .filter(([, field]) => counts[type] && field.sampled)
          .map(([field, spec]) => ({
            label: type + '.' + field,
            description: spec.unit,
            detail: spec.description,
            type,
            field,
          })),
      ),
      { title: 'Plot recorded field' },
    )
    return choice ? { type: choice.type, field: choice.field } : undefined
  }
  const pickPlot = (session: Session, title: string) =>
    vscode.window.showQuickPick(
      session.plots.map((plot) => ({
        label: plot.from + '.' + plot.field,
        description: plot.id,
        ...plot,
      })),
      { title },
    )
  /** Ask for an increasing `minimum, maximum` pair; undefined if cancelled. */
  const askRange = async (title: string, value?: string) => {
    const text = await vscode.window.showInputBox({ title, prompt: 'Minimum, maximum', value })
    if (text === undefined) return
    const range = text.split(/[, ]+/).map(Number)
    if (range.length !== 2 || !range.every(Number.isFinite) || range[0]! >= range[1]!)
      throw new Error('Enter two increasing finite bounds.')
    return [range[0]!, range[1]!] as const
  }
  /** Search the `type` elements by name, or by exact id once the input starts with `type/`. */
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
            limit: 100,
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
        if (!controller.signal.aborted) studio.output.warn(detail(error))
      } finally {
        if (current === generation) picker.busy = false
      }
    }
    return new Promise((resolve) => {
      const subscriptions = [
        picker.onDidChangeValue(() => {
          clearTimeout(timer)
          timer = setTimeout(() => void update(), 90)
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
      await vscode.commands.executeCommand('vscode.openWith', selected[0], 'gridkitStudio.network')
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
    await studio.documents.ensure(studio.documents.entries.get(context.session.uri)!.document)
    await vscode.commands.executeCommand('workbench.actions.view.problems')
  })
  command('followReference', async (context) => {
    if (!context.element || !context.field || !context.type) return
    const id = await referred(
      context,
      await valueOf(context, context.type, context.field, context.element.id),
      'This reference is disconnected.',
    )
    if (id) studio.select(context.session.uri, { id })
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
        title: field + (spec.unit ? ' [' + spec.unit + ']' : ''),
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
  command('copyReference', (context) => vscode.env.clipboard.writeText(context.element?.id ?? ''))
  command('copyValue', async (context) => {
    if (context.element && context.type && context.field)
      await vscode.env.clipboard.writeText(
        display(await valueOf(context, context.type, context.field, context.element.id)),
      )
  })
  // A second press while the first run starts, as a double click makes, asks for the same run.
  command('run', ({ session }) => (tasks.active(session.uri) ? undefined : tasks.run(session.uri)))
  register('stop', (value, supplied) => tasks.stop(targetOf(value, supplied).uri))
  command('showContingency', async ({ session }, value) => {
    if (session.run?.contingency && typeof value === 'number')
      await studio.client.call('contingency', { run: session.run.id, shown: value })
  })
  command('clearRun', async ({ session }) => {
    // The views let go of the runs before they go, and of the run a running run's end reports.
    studio.show(session, undefined)
    changed(session)
    await studio.client.call('clear', { uri: session.uri })
    studio.show(session, undefined)
    changed(session)
  })
  const plot = async (context: Context) => {
    const selected = await chooseSignal(context)
    if (!selected) return
    // From the Monitor, plot the field of every element; elsewhere, of the element in context.
    const element = context.target?.origin === 'monitor' ? undefined : context.element
    const id = element?.id.startsWith(selected.type + '/') ? element.id : undefined
    const plot: Plot = { from: selected.type, field: selected.field, ...(id ? { id } : {}) }
    await showPlot(studio, context.session, plot, context.element)
  }
  command('plot', plot)
  command('removePlot', async (context) => {
    const { session } = context
    const selected = context.target?.plot ?? (await pickPlot(session, 'Remove plot'))
    if (!selected) return
    session.plots = session.plots.filter(
      (plot) =>
        !(plot.from === selected.from && plot.field === selected.field && plot.id === selected.id),
    )
    changed(session)
  })
  command('signalElements', async (context) => {
    const plot = context.target?.plot ?? context.session.plots.at(-1)
    if (!plot) return
    const id = await pickReference(context, plot.from)
    if (id) {
      plot.id = id
      changed(context.session)
    }
  })
  command('addFault', async ({ session, element, type }) => {
    session.values.fault = true
    if (element && type === 'Bus') session.values.fault_bus = element.id
    changed(session)
    await focus(session, 'simulation')
  })
  command('importResults', async (context) => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit results': ['arrow', 'csv'] },
      canSelectMany: false,
    })
    if (!selected?.[0]) return
    await studio.client.call('import', {
      uri: context.session.uri,
      version: context.summary.version,
      path: localPath(selected[0]),
      cacheBytes: cacheBytesOf(selected[0]),
    })
    await plot(context)
  })
  command('exportCsv', async (context) => {
    if (!context.session.run) throw new Error('There is no run to export.')
    const path = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] } })
    if (path)
      await studio.client.call('export', { run: context.session.run.id, path: localPath(path) })
  })
  register('showOutput', () => studio.output.show())
  command('performance', async (context) => {
    studio.output.appendLine(
      JSON.stringify({
        ...(await studio.client.call('stats', {})),
        parseMs: context.summary.parseMs,
      }),
    )
    studio.output.show()
  })
  command('toggleTimeline', ({ session }) => session.transport.playPause())
  command('followTime', ({ session }) => session.transport.goLive())
  command('seekTime', async ({ session }, value) => {
    const { transport } = session
    if (transport.state.status === 'idle') return
    const text =
      typeof value === 'number'
        ? String(value)
        : await vscode.window.showInputBox({
            title: 'Time [s]',
            value: String(transport.currentT()),
          })
    if (text === undefined) return
    if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('Time must be finite.')
    transport.pause()
    transport.seek(Number(text))
  })
  for (const [id, direction] of [
    ['previousSample', -1],
    ['nextSample', 1],
  ] as const)
    command(id, ({ session }) => studio.step(session, direction))
  command('loopTime', async ({ session }) => {
    const loop = await vscode.window.showQuickPick<{ label: string; value: LoopMode }>(
      [
        { label: 'Once', value: 'none' },
        { label: 'Loop', value: 'wrap' },
        { label: 'Bounce', value: 'pingpong' },
      ],
      { title: 'Repeat playback' },
    )
    if (loop) session.transport.setLoop(loop.value)
  })
  command('timeSpeed', async ({ session }) => {
    const rate = await vscode.window.showQuickPick(['0.5', '1', '2', '4'], {
      title: 'Simulated seconds per second',
    })
    if (rate) session.transport.setRate(Number(rate))
  })
  for (const id of ['fit', 'neighborhood', 'orbit', 'retryMonitor'] as const)
    command(id, (context) =>
      action(context, id, undefined, id === 'retryMonitor' ? 'monitor' : undefined),
    )
  command('resetMonitorWindow', (context) => {
    context.session.window = undefined
    action(context, 'resetMonitorWindow', undefined, 'monitor')
    changed(context.session)
  })
  command('monitorWindow', async ({ session }) => {
    const range = await askRange(
      'Time window [s]',
      (session.window ?? session.run?.domain)?.join(', '),
    )
    if (!range) return
    session.window = range
    changed(session)
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
    if (selected) studio.select(context.session.uri, selected.element)
  })
  command('chooseColumns', async (context) => {
    const { schema, identities } = context.summary
    const type =
      context.session.table.type ?? context.type ?? Object.keys(context.summary.counts)[0]
    const definitions = type ? schema.types[type]?.fields : undefined
    if (!type || !definitions) throw new Error('This case has no elements to show.')
    const fields = Object.keys(definitions).filter(
      (field) => !definitions[field]!.sampled && field !== identities[type],
    )
    const selected = await vscode.window.showQuickPick(
      fields.map((field) => ({
        label: leaf(field),
        description: [
          field.includes('.') ? field.slice(0, field.indexOf('.')) : '',
          definitions[field]!.unit,
        ]
          .filter(Boolean)
          .join(' · '),
        field,
        picked: (context.session.table.fields ?? fields.slice(0, 12)).includes(field),
      })),
      { title: typeName(schema, type) + ' columns', canPickMany: true },
    )
    if (selected) {
      context.session.table.fields = selected.map((item) => item.field)
      action(context, 'columns', context.session.table.fields, 'case')
      changed(context.session)
    }
  })
  command('resetColumns', (context) => {
    context.session.table.fields = undefined
    action(context, 'resetColumns', undefined, 'case')
    changed(context.session)
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
      if (target) studio.select(context.session.uri, { id: target })
    })
  command('toggleDiagramEditing', (context) => {
    context.session.diagramEditing = !context.session.diagramEditing
    changed(context.session)
    action(context, 'diagramEditing', context.session.diagramEditing, 'diagram')
  })
  command('arrangeDiagram', (context) => action(context, 'arrangeDiagram', undefined, 'diagram'))
  command('reloadView', (context) => action(context, 'reloadView'))
  command('projection', async (context) => {
    const value = await vscode.window.showQuickPick(['flat', 'tilt', 'globe'], {
      title: 'Network projection',
    })
    if (value) action(context, 'projection', value, 'network')
  })
  /** The numeric field in context, which a network channel can show. */
  const mappable = ({ summary, type, field }: Context): FieldRef => {
    const definition = type && field ? summary.schema.types[type]?.fields[field] : undefined
    if (!type || !field || !NUMERIC.has(definition?.type))
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
      studio.bind(
        context.session.uri,
        field,
        picked.map(({ channel }) => channel),
        domainOf(bindings, field),
      )
  })
  command('mapRange', async (context) => {
    const field = mappable(context)
    const { bindings } = context.session
    const text = await vscode.window.showInputBox({
      title: 'Mapping range of ' + leaf(field.field),
      prompt: 'Low and high values; empty measures the values shown',
      value: domainOf(bindings, field)?.join(', ') ?? '',
      validateInput: (value) =>
        !value.trim() || rangeOf(value) ? null : 'Two numbers, low then high',
    })
    if (text !== undefined)
      studio.bind(context.session.uri, field, channelsOf(bindings, field), rangeOf(text))
  })
  command('unbind', (context) => studio.bind(context.session.uri, mappable(context), []))
  command('signalRange', async (context) => {
    const { plots } = context.session
    const plot =
      context.target?.plot ??
      (plots.length === 1 ? plots[0] : await pickPlot(context.session, 'Choose plot'))
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
    const setting = definitions.find((setting) => setting.id === 'network.colormap')!
    const name = await vscode.window.showQuickPick(
      'options' in setting
        ? setting.options.map((option) => ({ label: option.label, value: option.value }))
        : [],
      { title: 'Network colormap' },
    )
    if (name)
      await vscode.workspace
        .getConfiguration('gridkitStudio', vscode.Uri.parse(context.session.uri))
        .update(
          'network.colormap',
          name.value,
          vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global,
        )
  })
  for (const [id, category] of [
    ['networkSettings', 'network'],
    ['diagramSettings', 'diagram'],
    ['monitorSettings', 'monitor'],
  ] as const)
    command(id, () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'gridkitStudio.' + category),
    )
  register('simulationSettings', () =>
    vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@id:gridkitStudio.gridkitPath,gridkitStudio.gridkitImage,gridkitStudio.containerCli',
    ),
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
