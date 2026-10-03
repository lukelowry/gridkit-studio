import type { RowsBlock, Value } from '@latkit/model'
import * as vscode from 'vscode'

import { display, rowsOf } from './cells.js'
import { html, View } from './editors.js'
import type { Session, Sessions } from './sessions.js'
import { registerTasks } from './tasks.js'
import { elementOf, Node } from './trees.js'

export function registerCommands(studio: Sessions) {
  const tasks = registerTasks(studio)
  const registrations: vscode.Disposable[] = [tasks.provider]
  const monitors = new Map<string, vscode.WebviewPanel>()
  let playing: Session | undefined
  let playback: ReturnType<typeof setInterval> | undefined
  const command = (id: string, run: (value?: unknown) => unknown) =>
    registrations.push(
      vscode.commands.registerCommand('gridkitStudio.' + id, async (value) => {
        try {
          return await run(value)
        } catch (error) {
          studio.output.error(String(error))
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error),
          )
        }
      }),
    )
  const active = () => studio.current()
  const chosen = (value?: unknown) => elementOf(value) ?? active().selection
  const action = (id: string, value?: unknown) =>
    studio.action.fire({ uri: active().uri, command: id, value })
  const openEditor = async (kind: 'network' | 'diagram' | 'tableEditor', value?: unknown) => {
    const uri =
      value instanceof vscode.Uri
        ? value
        : studio.active
          ? vscode.Uri.parse(studio.active)
          : undefined
    if (!uri) return openCase()
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'gridkitStudio.' + kind,
      vscode.ViewColumn.Active,
    )
  }
  const openCase = async () => {
    const files = await vscode.window.showOpenDialog({
      filters: { 'GridKit cases': ['case.json', 'json'] },
      canSelectMany: false,
    })
    if (files?.[0]) await openEditor('network', files[0])
  }
  const monitor = () => {
    const session = active()
    let panel = monitors.get(session.uri)
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'gridkitStudio.monitor',
        'Monitor · ' + (studio.state(session.uri).summary?.name ?? 'GridKit'),
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: false },
      )
      new View(studio, panel, session.uri, 'monitor')
      monitors.set(session.uri, panel)
      panel.onDidDispose(() => monitors.delete(session.uri))
    } else panel.reveal(vscode.ViewColumn.Beside)
  }
  const plot = async (value?: unknown) => {
    const session = active()
    const state = studio.state(session.uri)
    if (!state.summary) return
    let from = value instanceof Node ? value.data.type : chosen(value)?.id.split('/')[0]
    let field = value instanceof Node ? value.data.field : chosen(value)?.field
    if (!from || !field || !state.summary.schema.types[from]?.fields[field]?.sampled) {
      const options = Object.entries(state.summary.schema.types).flatMap(([from, definition]) =>
        Object.entries(definition.fields)
          .filter(([, field]) => field.sampled && state.summary!.counts[from])
          .map(([field, definition]) => ({
            label: from + '.' + field,
            description: definition.unit,
            from,
            field,
          })),
      )
      const selected = await vscode.window.showQuickPick(options, { title: 'Plot a signal' })
      if (!selected) return
      from = selected.from
      field = selected.field
    }
    const id = value instanceof Node ? value.data.id : chosen(value)?.id
    if (!session.plots.some((p) => p.from === from && p.field === field && p.id === id))
      session.plots.push({ from, field, ...(id ? { id } : {}) })
    studio.changed.fire(session.uri)
    monitor()
  }
  command('openCase', openCase)
  for (const id of ['preview', 'reveal'])
    command(id, async (value) => {
      await openEditor('network', value)
      const element = chosen(value)
      if (element) studio.select(active().uri, element)
    })
  for (const id of ['openDiagram', 'revealDiagram'])
    command(id, (value) => openEditor('diagram', value))
  for (const id of ['openTable', 'showInTable'])
    command(id, (value) => openEditor('tableEditor', value))
  command('showSource', () => studio.documents.reveal(active().uri))
  command('elementSource', (value) => studio.documents.reveal(active().uri, chosen(value)))
  command('validateCase', async () => {
    const entry = studio.documents.entries.get(active().uri)
    if (entry) await studio.documents.parse(entry.document)
    await vscode.commands.executeCommand('workbench.actions.view.problems')
  })
  command('inspectField', async (value) => {
    const element = chosen(value)
    if (!element) return
    studio.select(active().uri, element)
    const node = value instanceof Node ? value : undefined
    const reference = node?.data.value as { index?: { type: string }; row?: number } | undefined
    if (reference?.index && reference.row !== undefined) {
      const summary = studio.state(active().uri).summary!
      const blocks = (await studio.client.call('query', {
        uri: active().uri,
        version: summary.version,
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
      if (id) studio.select(active().uri, { id })
    }
  })
  command('editField', async (value) => {
    const session = active()
    const state = studio.state(session.uri)
    const element = chosen(value)
    if (!state.summary || !element) return
    const type = element.id.split('/')[0]!
    const definition = state.summary.schema.types[type]!
    const field =
      element.field ??
      (await vscode.window.showQuickPick(state.summary.editable[type] ?? [], {
        title: 'Edit field',
      }))
    if (!field) return
    const spec = definition.fields[field]!
    let next: Value
    if (typeof spec.type === 'object' && spec.type.kind === 'reference') {
      const target = spec.type.to
      const blocks = (await studio.client.call('query', {
        uri: session.uri,
        version: state.summary.version,
        query: { kind: 'rows', from: target, select: [], limit: 100, ids: true },
      })) as RowsBlock[]
      const selected = await vscode.window.showQuickPick(
        rowsOf(blocks)
          .map((row) => row.id!)
          .filter(Boolean),
        { title: 'Choose reference (first 100; type an ID in Table for others)' },
      )
      if (!selected) return
      next = selected
    } else if (spec.type === 'boolean') {
      const result = await vscode.window.showQuickPick(['true', 'false'], { title: field })
      if (!result) return
      next = result === 'true'
    } else {
      const input = await vscode.window.showInputBox({
        title: field + (spec.unit ? ' [' + spec.unit + ']' : ''),
        value:
          value instanceof Node && value.data.value !== null
            ? spec.type === 'text'
              ? String(value.data.value)
              : JSON.stringify(value.data.value)
            : '',
      })
      if (input === undefined) return
      next = spec.type === 'text' ? input : JSON.parse(input)
    }
    await studio.documents.edit(session.uri, state.summary.version, { ...element, field }, next)
  })
  for (const id of ['copyReference', 'copyIdentifier'])
    command(id, (value) => vscode.env.clipboard.writeText(chosen(value)?.id ?? ''))
  command('copyValue', (value) =>
    vscode.env.clipboard.writeText(value instanceof Node ? display(value.data.value) : ''),
  )
  command('runSolver', () => tasks.run(active().uri))
  command('stopSolver', () => studio.client.call('stop', { uri: active().uri }))
  command('clearRun', async () => {
    const session = active()
    await studio.client.call('clear', { uri: session.uri })
    session.run = session.previous = undefined
    session.at = undefined
    studio.changed.fire(session.uri)
  })
  command('openMonitor', monitor)
  for (const id of ['plot', 'monitorField', 'signalElements']) command(id, plot)
  command('findSignal', plot)
  command('removePlot', async () => {
    const session = active()
    const selected = await vscode.window.showQuickPick(
      session.plots.map((plot, index) => ({
        label: plot.from + '.' + plot.field,
        description: plot.id,
        index,
      })),
      { title: 'Remove plot' },
    )
    if (selected) {
      session.plots.splice(selected.index, 1)
      studio.changed.fire(session.uri)
    }
  })
  command('monitorSignals', async () => {
    const session = active()
    const summary = studio.state(session.uri).summary
    if (!summary) return
    const options = Object.entries(summary.schema.types).flatMap(([from, definition]) =>
      Object.entries(definition.fields)
        .filter(([, field]) => field.sampled && summary.counts[from])
        .map(([field, definition]) => ({
          label: from + '.' + field,
          description: definition.unit,
          from,
          field,
          picked: session.outputs.some(
            (selection) => selection.from === from && selection.select.includes(field),
          ),
        })),
    )
    const selection = await vscode.window.showQuickPick(options, {
      title: 'Recorded outputs',
      canPickMany: true,
    })
    if (selection)
      session.outputs = selection.map((item) => ({ from: item.from, select: [item.field] }))
  })
  command('chooseConfiguration', async () => {
    const session = active()
    const uris = await vscode.workspace.findFiles('**/*.solver.json', '**/node_modules/**', 100)
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Use simulation form', uri: undefined },
        ...uris.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
      ],
      { title: 'Simulation configuration' },
    )
    if (choice) {
      session.configuration = choice.uri
      studio.changed.fire(session.uri)
    }
  })
  command('openConfiguration', async () => {
    if (active().configuration) await vscode.window.showTextDocument(active().configuration!)
  })
  command('saveConfiguration', async () => {
    const session = active()
    const summary = studio.state(session.uri).summary
    if (!summary) return
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.parse(session.uri.replace(/\.case\.json$/i, '.solver.json')),
      filters: { 'Solver configuration': ['solver.json'] },
    })
    if (!uri) return
    const values = Object.fromEntries(
      Object.entries(summary.parameters)
        .filter(([key]) => !key.startsWith('fault') && key !== 'output_format')
        .flatMap(([key, spec]) => {
          const value = session.values[key] ?? ('default' in spec ? spec.default : undefined)
          return value === undefined ? [] : [[key, value]]
        }),
    )
    await vscode.workspace.fs.writeFile(
      uri,
      new TextEncoder().encode(
        JSON.stringify(
          { system_model_file: vscode.Uri.parse(session.uri).fsPath, ...values, events: [] },
          null,
          2,
        ) + '\n',
      ),
    )
    session.configuration = uri
  })
  for (const id of ['addEvent', 'addFault', 'selectFault'])
    command(id, async () => {
      active().values.fault = true
      studio.changed.fire(active().uri)
      await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
    })
  command('openCsv', async () => {
    const paths = await vscode.window.showOpenDialog({
      filters: { 'GridKit results': ['csv', 'arrow'] },
    })
    const session = active()
    const summary = studio.state(session.uri).summary
    if (paths?.[0] && summary) {
      await studio.client.call('import', {
        uri: session.uri,
        version: summary.version,
        path: paths[0].fsPath,
        cacheBytes: 256 << 20,
      })
      await plot()
    }
  })
  command('exportCsv', async () => {
    const run = active().run
    if (!run) throw new Error('There is no run to export.')
    const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] } })
    if (uri) await studio.client.call('export', { run: run.id, path: uri.fsPath })
  })
  command('showSolverOutput', () => studio.output.show())
  command('performance', async () => {
    const stats = await studio.client.call('stats', {})
    studio.output.appendLine(
      JSON.stringify({ ...stats, parseMs: studio.state(active().uri).summary?.parseMs }),
    )
    studio.output.show()
  })
  command('updateRuntime', () =>
    vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'gridkitStudio.simulationMethod',
    ),
  )
  command('seekTime', async (value) => {
    const session = active()
    const run = session.run
    if (!run) return
    const text =
      typeof value === 'number'
        ? String(value)
        : await vscode.window.showInputBox({
            title: 'Time [s]',
            value: String(session.at ?? run.domain[0]),
          })
    if (text === undefined) return
    const at = Number(text)
    if (!Number.isFinite(at)) throw new Error('Time must be finite.')
    session.at = Math.max(run.domain[0], Math.min(run.domain[1], at))
    session.follow = false
    studio.changed.fire(session.uri)
  })
  for (const [id, step] of [
    ['previousSample', -1],
    ['nextSample', 1],
  ] as const)
    command(id, async () => {
      const session = active()
      const run = session.run
      if (!run) return
      session.at = await studio.client.call('step', {
        run: run.id,
        at: session.at ?? run.domain[0],
        direction: step,
      })
      session.follow = false
      studio.changed.fire(session.uri)
    })
  for (const [id, key, value] of [
    ['followTime', 'follow', true],
    ['unfollowTime', 'follow', false],
    ['loopTime', 'loop', true],
    ['unloopTime', 'loop', false],
  ] as const)
    command(id, () => {
      const session = active()
      session[key] = value
      if (key === 'follow' && value) session.at = session.run?.domain[1]
      studio.changed.fire(session.uri)
    })
  command('timeSpeed', async () => {
    const speed = await vscode.window.showQuickPick(['0.25', '0.5', '1', '2', '4'], {
      title: 'Playback speed',
    })
    if (speed) active().speed = Number(speed)
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
  command('pauseTimeline', pause)
  command('toggleTimeline', () => {
    const session = active()
    if (playing === session) return pause()
    pause()
    if (!session.run?.frames) return
    playing = session
    session.playing = true
    if ((session.at ?? 0) >= session.run.domain[1]) session.at = session.run.domain[0]
    session.follow = false
    studio.changed.fire(session.uri)
    playback = setInterval(() => {
      const run = session.run
      if (!run || !studio.all.has(session.uri)) return pause()
      const next = (session.at ?? run.domain[0]) + session.speed * 0.05
      session.at =
        next > run.domain[1] && session.loop ? run.domain[0] : Math.min(next, run.domain[1])
      studio.changed.fire(session.uri)
      if (next >= run.domain[1] && !session.loop) pause()
    }, 50)
  })
  for (const id of [
    'fit',
    'neighborhood',
    'orbit',
    'retryMonitor',
    'resetMonitorWindow',
    'chooseColumns',
    'resetColumns',
    'clearTableFilter',
  ])
    command(id, (value) => action(id, value))

  command('chooseOverlapping', async () => {
    const elements = active().overlaps ?? (active().selection ? [active().selection!] : [])
    const chosen = await vscode.window.showQuickPick(
      elements.map((element) => ({ label: element.id, description: element.field, element })),
      { title: 'Elements under the pointer' },
    )
    if (chosen) studio.select(active().uri, chosen.element)
  })
  command('selectClass', async () => {
    const summary = studio.state(active().uri).summary
    if (!summary) return
    const type = await vscode.window.showQuickPick(
      Object.keys(summary.counts).filter((type) => summary.counts[type]),
      { title: 'Element type' },
    )
    if (type) action('selectClass', type)
  })
  command('monitorWindow', async (value) => {
    const text =
      typeof value === 'string'
        ? value
        : await vscode.window.showInputBox({
            title: 'Time window [s]',
            prompt: 'Enter minimum, maximum',
            value: active().run?.domain.join(', '),
          })
    if (text === undefined) return
    const bounds = text.split(/[, ]+/).map(Number)
    if (bounds.length !== 2 || !bounds.every(Number.isFinite) || bounds[0]! >= bounds[1]!)
      throw new Error('Enter two finite, increasing bounds.')
    active().follow = false
    action('monitorWindow', bounds.join(','))
    studio.changed.fire(active().uri)
  })
  for (const [id, side] of [
    ['fromEndpoint', 0],
    ['toEndpoint', 1],
  ] as const)
    command(id, async (value) => {
      const element = chosen(value)
      const session = active()
      const summary = studio.state(session.uri).summary
      if (!element || !summary) return
      const type = element.id.split('/')[0]!
      const refs = Object.entries(summary.schema.types[type]!.fields).filter(
        ([, field]) =>
          typeof field.type === 'object' &&
          field.type.kind === 'reference' &&
          summary.schema.types[field.type.to]?.spatial,
      )
      const field = refs[side]?.[0]
      if (!field) throw new Error('This element has no corresponding endpoint.')
      const result = rowsOf(
        (await studio.client.call('query', {
          uri: session.uri,
          version: summary.version,
          query: {
            kind: 'rows',
            from: type,
            select: [field],
            rows: { kind: 'ids', ids: [element.id] },
            limit: 1,
          },
        })) as RowsBlock[],
      )
      const reference = result[0]?.values[field] as { index: { type: string }; row: number } | null
      if (!reference) throw new Error('The endpoint is disconnected.')
      const target = rowsOf(
        (await studio.client.call('query', {
          uri: session.uri,
          version: summary.version,
          query: {
            kind: 'rows',
            from: reference.index.type,
            select: [],
            rows: { kind: 'range', offset: reference.row, count: 1 },
            ids: true,
            limit: 1,
          },
        })) as RowsBlock[],
      )[0]?.id
      if (target) studio.select(session.uri, { id: target })
    })
  command('projection', async () => {
    const value = await vscode.window.showQuickPick(['flat', 'tilt', 'globe'], {
      title: 'Network projection',
    })
    if (value) action('projection', value)
  })
  for (const id of ['filterTable', 'signalRange', 'bindingRange'])
    command(id, async () => {
      const value = await vscode.window.showInputBox({
        title: id === 'filterTable' ? 'Filter text' : id,
      })
      if (value !== undefined) action(id, value)
    })
  command('bind', async (value) => {
    const item = value instanceof Node ? value.data : undefined
    if (item?.type && item.field) {
      active().bindings[item.type] = item.field
      studio.changed.fire(active().uri)
    } else {
      await plot(value)
      const latest = active().plots.at(-1)
      if (latest) {
        active().bindings[latest.from] = latest.field
        studio.changed.fire(active().uri)
      }
    }
  })
  command('unbind', () => {
    active().bindings = {}
    studio.changed.fire(active().uri)
    action('unbind')
  })
  for (const id of ['options', 'monitorOptions'])
    command(id, () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'gridkitStudio'),
    )
  command('signalColormap', async () => {
    const name = await vscode.window.showQuickPick(
      ['viridis', 'cividis', 'plasma', 'magma', 'coolwarm', 'turbo'],
      { title: 'Binding colormap' },
    )
    if (name) action('signalColormap', name)
  })
  registrations.push({ dispose: pause })
  const provider = vscode.window.registerWebviewViewProvider('gridkitStudio.simulation', {
    resolveWebviewView(view) {
      view.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(studio.context.extensionUri, 'dist', 'webview')],
      }
      view.webview.html = html(view.webview, studio.context, 'simulation', 'simulation')
      const update = () => {
        if (studio.active)
          void view.webview.postMessage({
            kind: 'state',
            state: studio.state(studio.active),
            values: active().values,
            configuration: active().configuration
              ? vscode.workspace.asRelativePath(active().configuration!)
              : undefined,
          })
      }
      const changed = studio.changed.event(update)
      const messages = view.webview.onDidReceiveMessage((message) => {
        if (message?.kind === 'ready') update()
        else if (
          message?.kind === 'values' &&
          studio.active &&
          message.values &&
          typeof message.values === 'object'
        )
          active().values = message.values
        else if (
          message?.kind === 'command' &&
          [
            'runSolver',
            'stopSolver',
            'chooseConfiguration',
            'monitorSignals',
            'openConfiguration',
          ].includes(message.command)
        )
          void vscode.commands.executeCommand('gridkitStudio.' + message.command)
      })
      view.onDidDispose(() => {
        changed.dispose()
        messages.dispose()
      })
    },
  })
  registrations.push(provider)
  return registrations
}
