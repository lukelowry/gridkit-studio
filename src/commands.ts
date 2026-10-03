import type { RowsBlock, Value } from '@latkit/model'
import * as vscode from 'vscode'

import { type Channel, CHANNELS, channelsFor } from './bindings.js'
import { display, rowsOf } from './cells.js'
import type { Target } from './contexts.js'
import { reviewChanges } from './git.js'
import type { Element, Plot, Summary } from './messages.js'
import { definitions } from './preferences.js'
import type { Session, Sessions } from './sessions.js'
import { registerTasks } from './tasks.js'
import { Node } from './trees.js'
import { networkOf, placementOf } from './webview/topology.js'

interface Context {
  session: Session
  summary: Summary
  target?: Target
  element?: Element
  type?: string
  field?: string
}
export function registerCommands(studio: Sessions) {
  const tasks = registerTasks(studio)
  const registrations: vscode.Disposable[] = [tasks.provider]
  let playing: Session | undefined
  let playback: ReturnType<typeof setInterval> | undefined
  const targetOf = (value?: unknown, supplied?: { uri?: string; view?: string }) => {
    let target: Target | undefined
    if (value instanceof Node) target = value.target
    else if (value && typeof value === 'object' && 'gridkitTarget' in value)
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
  const resolve = async (
    value?: unknown,
    supplied?: { uri?: string; view?: string },
  ): Promise<Context> => {
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
      type: target?.type ?? element?.id.split('/')[0],
      field: target?.field ?? element?.field,
    }
  }
  const register = (
    id: string,
    run: (value?: unknown, supplied?: { uri?: string; view?: string }) => unknown,
  ) =>
    registrations.push(
      vscode.commands.registerCommand('gridkitStudio.' + id, async (value, supplied) => {
        try {
          return await run(value, supplied)
        } catch (error) {
          studio.output.error(String(error))
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error),
          )
        }
      }),
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
  const panel = async (context: Context, kind: 'table' | 'monitor') => {
    studio.activate(context.session.uri)
    if (context.element) studio.select(context.session.uri, context.element)
    await vscode.commands.executeCommand('gridkitStudio.' + kind + '.focus')
  }
  const rows = async (context: Context, from: string, select: string[], ids?: string[]) =>
    rowsOf(
      (await studio.client.call('query', {
        uri: context.session.uri,
        version: context.summary.version,
        query: {
          kind: 'rows',
          from,
          select,
          ids: true,
          limit: 100,
          ...(ids ? { rows: { kind: 'ids', ids } } : {}),
        },
      })) as RowsBlock[],
    )
  async function chooseField(
    context: Context,
    sampledOnly: boolean,
  ): Promise<{ type: string; field: string } | undefined> {
    const existing =
      context.type && context.field
        ? context.summary.schema.types[context.type]?.fields[context.field]
        : undefined
    if (existing && (!sampledOnly || existing.sampled))
      return { type: context.type!, field: context.field! }
    const choice = await vscode.window.showQuickPick(
      Object.entries(context.summary.schema.types).flatMap(([type, definition]) =>
        Object.entries(definition.fields)
          .filter(
            ([, field]) =>
              context.summary.counts[type] &&
              (sampledOnly
                ? field.sampled
                : ['float64', 'float32', 'int32', 'uint32', 'boolean'].includes(
                    String(field.type),
                  )),
          )
          .map(([field, spec]) => ({
            label: type + '.' + field,
            description: spec.unit,
            detail: spec.description,
            type,
            field,
          })),
      ),
      { title: sampledOnly ? 'Plot recorded field' : 'Choose a field' },
    )
    return choice ? { type: choice.type, field: choice.field } : undefined
  }
  async function pickReference(context: Context, type: string): Promise<string | undefined> {
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
        const blocks = (await studio.client.call(
          'query',
          {
            uri: context.session.uri,
            version: context.summary.version,
            query: {
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
          },
          controller.signal,
        )) as RowsBlock[]
        if (current !== generation) return
        picker.items = rowsOf(blocks)
          .filter((row) => row.id)
          .map((row) => ({
            label: name ? display(row.values[name]) : row.id!,
            description: row.id!,
            id: row.id!,
          }))
      } catch (error) {
        if (!controller.signal.aborted) studio.output.warn(String(error))
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
  command('preview', (context) => open(context, 'network'))
  command('reveal', (context) => open(context, 'network'))
  command('openDiagram', (context) => open(context, 'diagram'))
  command('revealDiagram', (context) => open(context, 'diagram'))
  command('openTable', (context) => panel(context, 'table'))
  command('showInTable', (context) => panel(context, 'table'))
  command('openMonitor', (context) => panel(context, 'monitor'))
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
  command('inspectField', async (context) => {
    if (context.element) studio.select(context.session.uri, context.element)
    await vscode.commands.executeCommand('gridkitStudio.inspector.focus')
  })
  command('followReference', async (context) => {
    if (!context.element || !context.field || !context.type) return
    const row = (await rows(context, context.type, [context.field], [context.element.id]))[0]
    const reference = row?.values[context.field] as {
      index?: { type: string }
      row?: number
    } | null
    if (!reference?.index || reference.row === undefined)
      throw new Error('This reference is disconnected.')
    const blocks = (await studio.client.call('query', {
      uri: context.session.uri,
      version: context.summary.version,
      query: {
        kind: 'rows',
        from: reference.index.type,
        select: [],
        rows: { kind: 'range', offset: reference.row, count: 1 },
        ids: true,
        limit: 1,
      },
    })) as RowsBlock[]
    const id = rowsOf(blocks)[0]?.id
    if (id) studio.select(context.session.uri, { id })
  })
  command('editField', async (context) => {
    const { session, summary, element } = context
    if (!element) return
    const type = element.id.split('/')[0]!
    const field =
      context.field ??
      (await vscode.window.showQuickPick(summary.editable[type] ?? [], {
        title: 'Edit ' + element.id,
      }))
    if (!field) return
    const spec = summary.schema.types[type]!.fields[field]!
    const current = (await rows(context, type, [field], [element.id]))[0]?.values[field]
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
          return undefined
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
        display(
          (await rows(context, context.type, [context.field], [context.element.id]))[0]?.values[
            context.field
          ],
        ),
      )
  })
  command('runSolver', (context) => tasks.run(context.session.uri))
  register('stopSolver', (value, supplied) =>
    studio.client.call('stop', { uri: targetOf(value, supplied).uri }),
  )
  command('clearRun', async (context) => {
    const session = context.session
    if (playing === session) pause()
    await studio.client.call('clear', { uri: session.uri })
    session.run = session.previous = undefined
    session.at = undefined
    session.window = undefined
    changed(session)
  })
  const plot = async (context: Context) => {
    const selected = await chooseField(context, true)
    if (!selected) return
    const id = context.element?.id.startsWith(selected.type + '/') ? context.element.id : undefined
    const plot: Plot = { from: selected.type, field: selected.field, ...(id ? { id } : {}) }
    if (!context.session.plots.some((item) => JSON.stringify(item) === JSON.stringify(plot)))
      context.session.plots.push(plot)
    changed(context.session)
    await panel(context, 'monitor')
  }
  command('plot', plot)
  command('findSignal', plot)
  command('removePlot', async (context) => {
    const session = context.session
    const targeted = context.target?.plot
    const selected =
      targeted ??
      (await vscode.window.showQuickPick(
        session.plots.map((plot) => ({
          label: plot.from + '.' + plot.field,
          description: plot.id,
          ...plot,
        })),
        { title: 'Remove plot' },
      ))
    if (selected) {
      session.plots = session.plots.filter(
        (plot) =>
          !(
            plot.from === selected.from &&
            plot.field === selected.field &&
            plot.id === selected.id
          ),
      )
      changed(session)
    }
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
  command('monitorSignals', async (context) => {
    const { session, summary } = context
    const choices = Object.entries(summary.schema.types).flatMap(([from, spec]) =>
      Object.entries(spec.fields)
        .filter(([, field]) => field.sampled && summary.counts[from])
        .map(([field, spec]) => ({
          label: from + '.' + field,
          description: spec.unit,
          from,
          field,
          picked: session.outputs.some(
            (output) => output.from === from && output.select.includes(field),
          ),
        })),
    )
    const selected = await vscode.window.showQuickPick(choices, {
      title: 'Recorded outputs',
      canPickMany: true,
    })
    if (selected) {
      session.outputs = selected.map((item) => ({ from: item.from, select: [item.field] }))
      changed(session)
    }
  })
  command('addFault', async (context) => {
    context.session.values.fault = true
    if (context.element && context.type === 'Bus')
      context.session.values.fault_bus = context.element.id
    changed(context.session)
    studio.activate(context.session.uri)
    await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
  })
  command('importResults', async (context) => {
    const selected = await vscode.window.showOpenDialog({
      filters: { 'GridKit results': ['arrow', 'csv'] },
      canSelectMany: false,
    })
    if (!selected?.[0]) return
    const cacheBytes =
      vscode.workspace
        .getConfiguration('gridkitStudio', selected[0])
        .get<number>('resultCacheMiB', 256) *
      (1 << 20)
    await studio.client.call('import', {
      uri: context.session.uri,
      version: context.summary.version,
      path: selected[0].fsPath,
      cacheBytes,
    })
    await plot(context)
  })
  command('exportCsv', async (context) => {
    if (!context.session.run) throw new Error('There is no run to export.')
    const path = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] } })
    if (path) await studio.client.call('export', { run: context.session.run.id, path: path.fsPath })
  })
  register('showSolverOutput', () => studio.output.show())
  command('performance', async (context) => {
    studio.output.appendLine(
      JSON.stringify({
        ...(await studio.client.call('stats', {})),
        parseMs: context.summary.parseMs,
      }),
    )
    studio.output.show()
  })
  const pause = () => {
    clearInterval(playback)
    playback = undefined
    if (playing) {
      playing.playing = false
      studio.changed.fire(playing.uri)
      playing = undefined
    }
  }
  register('pauseTimeline', () => pause())
  command('toggleTimeline', (context) => {
    const session = context.session
    if (playing === session) return pause()
    pause()
    if ((session.run?.frames ?? 0) < 2) return
    playing = session
    session.playing = true
    session.follow = false
    const run = session.run!
    if ((session.at ?? run.domain[1]) >= run.domain[1]) session.at = run.domain[0]
    let before = performance.now()
    session.direction = 1
    studio.changed.fire(session.uri)
    playback = setInterval(() => {
      const run = session.run
      if (!run || !studio.all.has(session.uri)) return pause()
      const now = performance.now()
      let next =
        (session.at ?? run.domain[0]) + ((now - before) / 1000) * session.speed * session.direction
      before = now
      const [start, end] = run.domain
      const span = end - start
      if (span <= 0) return pause()
      if (next > end || next < start) {
        if (session.loop === 'wrap') next = start + ((((next - start) % span) + span) % span)
        else if (session.loop === 'pingpong') {
          const phase = (((next - start) % (2 * span)) + 2 * span) % (2 * span)
          next = start + (phase <= span ? phase : 2 * span - phase)
          session.direction = phase <= span ? 1 : -1
        } else {
          session.at = Math.max(start, Math.min(end, next))
          studio.changed.fire(session.uri)
          return pause()
        }
      }
      session.at = next
      studio.changed.fire(session.uri)
    }, 50)
  })
  command('seekTime', async (context, value) => {
    const run = context.session.run
    if (!run) return
    const text =
      typeof value === 'number'
        ? String(value)
        : await vscode.window.showInputBox({
            title: 'Time [s]',
            value: String(context.session.at ?? run.domain[0]),
          })
    if (text === undefined) return
    if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('Time must be finite.')
    if (playing === context.session) pause()
    context.session.at = Math.max(run.domain[0], Math.min(run.domain[1], Number(text)))
    context.session.follow = false
    changed(context.session)
  })
  for (const [id, direction] of [
    ['previousSample', -1],
    ['nextSample', 1],
  ] as const)
    command(id, async (context) => {
      const session = context.session
      if (!session.run) return
      if (playing === session) pause()
      session.at = await studio.client.call('step', {
        run: session.run.id,
        at: session.at ?? session.run.domain[0],
        direction,
      })
      session.follow = false
      changed(session)
    })
  command('followTime', (context) => {
    pause()
    context.session.follow = true
    context.session.at = context.session.run?.domain[1]
    changed(context.session)
  })
  command('unfollowTime', (context) => {
    context.session.follow = false
    changed(context.session)
  })
  command('loopTime', async (context) => {
    const loop = await vscode.window.showQuickPick(
      [
        { label: 'Once', value: 'none' },
        { label: 'Loop', value: 'wrap' },
        { label: 'Bounce', value: 'pingpong' },
      ] as const,
      { title: 'Repeat playback' },
    )
    if (loop) {
      context.session.loop = loop.value
      changed(context.session)
    }
  })
  command('unloopTime', (context) => {
    context.session.loop = 'none'
    changed(context.session)
  })
  command('timeSpeed', async (context) => {
    const rate = await vscode.window.showQuickPick(['0.25', '0.5', '1', '2', '4'], {
      title: 'Simulated seconds per second',
    })
    if (rate) {
      context.session.speed = Number(rate)
      changed(context.session)
    }
  })
  for (const id of ['fit', 'neighborhood', 'orbit', 'retryMonitor'] as const)
    command(id, (context) =>
      action(context, id, undefined, id === 'retryMonitor' ? 'monitor' : undefined),
    )
  command('resetMonitorWindow', (context) => {
    context.session.window = undefined
    context.session.follow = true
    action(context, 'resetMonitorWindow', undefined, 'monitor')
    changed(context.session)
  })
  command('monitorWindow', async (context) => {
    const value = await vscode.window.showInputBox({
      title: 'Time window [s]',
      prompt: 'Minimum, maximum',
      value: (context.session.window ?? context.session.run?.domain)?.join(', '),
    })
    if (value === undefined) return
    const range = value.split(/[, ]+/).map(Number)
    if (range.length !== 2 || !range.every(Number.isFinite) || range[0]! >= range[1]!)
      throw new Error('Enter two increasing finite bounds.')
    context.session.follow = false
    context.session.window = [range[0]!, range[1]!]
    action(context, 'monitorWindow', range.join(','), 'monitor')
    changed(context.session)
  })
  command('chooseOverlapping', async (context) => {
    const selected = await vscode.window.showQuickPick(
      (context.target?.items ?? context.session.overlaps ?? []).map((element) => ({
        label: element.id,
        description: element.field,
        element,
      })),
      { title: 'Elements under the pointer' },
    )
    if (selected) studio.select(context.session.uri, selected.element)
  })
  command('selectClass', async (context) => {
    const type = await vscode.window.showQuickPick(
      Object.keys(context.summary.counts).filter((type) => context.summary.counts[type]),
      { title: 'Element type' },
    )
    if (type) {
      context.session.table.type = type
      context.session.table.fields = undefined
      action(context, 'selectClass', type, 'table')
      changed(context.session)
    }
  })
  command('chooseColumns', async (context) => {
    const type =
      context.session.table.type ?? context.type ?? Object.keys(context.summary.counts)[0]!
    const fields = Object.keys(context.summary.schema.types[type]!.fields).filter(
      (field) => !context.summary.schema.types[type]!.fields[field]!.sampled,
    )
    const selected = await vscode.window.showQuickPick(
      fields.map((field) => ({
        label: field,
        picked: (context.session.table.fields ?? fields.slice(0, 12)).includes(field),
      })),
      { title: type + ' columns', canPickMany: true },
    )
    if (selected) {
      context.session.table.fields = selected.map((item) => item.label)
      action(context, 'columns', context.session.table.fields, 'table')
      changed(context.session)
    }
  })
  command('resetColumns', (context) => {
    context.session.table.fields = undefined
    action(context, 'resetColumns', undefined, 'table')
    changed(context.session)
  })
  command('filterTable', async (context) => {
    const value = await vscode.window.showInputBox({
      title: 'Filter names',
      value: context.session.table.filter ?? '',
    })
    if (value !== undefined) {
      context.session.table.filter = value
      action(context, 'filterTable', value, 'table')
      changed(context.session)
    }
  })
  command('clearTableFilter', (context) => {
    context.session.table.filter = ''
    action(context, 'clearTableFilter', undefined, 'table')
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
      const value = (await rows(context, context.type, [field], [context.element.id]))[0]?.values[
        field
      ] as { index?: { type: string }; row?: number } | null
      if (!value?.index || value.row === undefined) throw new Error('The endpoint is disconnected.')
      const blocks = (await studio.client.call('query', {
        uri: context.session.uri,
        version: context.summary.version,
        query: {
          kind: 'rows',
          from: value.index.type,
          select: [],
          rows: { kind: 'range', offset: value.row, count: 1 },
          ids: true,
          limit: 1,
        },
      })) as RowsBlock[]
      const target = rowsOf(blocks)[0]?.id
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
  command('bind', async (context) => {
    const selected = await chooseField(context, false)
    if (!selected) return
    const allowed = channelsFor(placementOf(networkOf(context.summary.schema), selected.type))
    if (!allowed.length) throw new Error('This type has no network display channels.')
    const channels = await vscode.window.showQuickPick(
      allowed.map((channel) => {
        const owner = context.session.bindings[channel]
        return {
          label: CHANNELS[channel].label,
          description: owner ? owner.type + '.' + owner.field : undefined,
          channel,
          picked: owner?.type === selected.type && owner.field === selected.field,
        }
      }),
      { title: 'Map ' + selected.type + '.' + selected.field, canPickMany: true },
    )
    if (!channels) return
    for (const channel of allowed) {
      const current = context.session.bindings[channel]
      if (channels.some((item) => item.channel === channel))
        context.session.bindings[channel] = selected
      else if (current?.type === selected.type && current.field === selected.field)
        delete context.session.bindings[channel]
    }
    changed(context.session)
  })
  command('unbind', async (context) => {
    if (context.type && context.field) {
      for (const [channel, binding] of Object.entries(context.session.bindings))
        if (binding.type === context.type && binding.field === context.field)
          delete context.session.bindings[channel as Channel]
    } else {
      const selected = await vscode.window.showQuickPick(
        Object.entries(context.session.bindings).map(([channel, binding]) => ({
          label: CHANNELS[channel as Channel].label,
          description: binding.type + '.' + binding.field,
          channel,
        })),
        { title: 'Remove mapping' },
      )
      if (!selected) return
      delete context.session.bindings[selected.channel as Channel]
    }
    changed(context.session)
  })
  command('bindingRange', async (context) => {
    const choices = Object.entries(context.session.bindings)
      .filter(
        ([, binding]) =>
          !context.field || (binding.field === context.field && binding.type === context.type),
      )
      .map(([channel, binding]) => ({
        label: CHANNELS[channel as Channel].label,
        description: binding.type + '.' + binding.field,
        binding,
      }))
    const selected =
      choices.length === 1
        ? choices[0]
        : await vscode.window.showQuickPick(choices, { title: 'Mapping range' })
    if (!selected) return
    const input = await vscode.window.showInputBox({
      title: 'Mapping input range',
      prompt: 'Minimum, maximum; empty restores automatic range',
      value: selected.binding.domain?.join(', ') ?? '',
    })
    if (input === undefined) return
    if (!input.trim()) delete selected.binding.domain
    else {
      const range = input.split(/[, ]+/).map(Number)
      if (range.length !== 2 || !range.every(Number.isFinite) || range[0]! >= range[1]!)
        throw new Error('Enter two increasing finite bounds.')
      selected.binding.domain = [range[0]!, range[1]!]
    }
    changed(context.session)
  })
  command('signalRange', async (context) => {
    const plot =
      context.target?.plot ??
      (context.session.plots.length === 1
        ? context.session.plots[0]
        : await vscode.window.showQuickPick(
            context.session.plots.map((plot) => ({
              label: plot.from + '.' + plot.field,
              description: plot.id,
              ...plot,
            })),
            { title: 'Choose plot' },
          ))
    if (!plot) return
    const text = await vscode.window.showInputBox({
      title: 'Plot value range',
      prompt: 'Minimum, maximum',
    })
    if (text === undefined) return
    const range = text.split(/[, ]+/).map(Number)
    if (range.length !== 2 || !range.every(Number.isFinite) || range[0]! >= range[1]!)
      throw new Error('Enter two increasing finite bounds.')
    action(
      context,
      'signalRange',
      { plot: { from: plot.from, field: plot.field, ...(plot.id ? { id: plot.id } : {}) }, range },
      'monitor',
    )
  })
  command('signalColormap', async (context) => {
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
        .update('network.colormap', name.value, vscode.ConfigurationTarget.Workspace)
  })
  for (const [id, category] of [
    ['networkSettings', 'network'],
    ['diagramSettings', 'diagram'],
    ['monitorOptions', 'monitor'],
    ['simulationSettings', 'simulationMethod'],
  ] as const)
    command(id, () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'gridkitStudio.' + category),
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
  command('reviewChanges', async (context) => {
    await reviewChanges(vscode.Uri.parse(context.session.uri))
  })
  registrations.push({ dispose: pause })
  return registrations
}
