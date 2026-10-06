import type { FieldSelection } from '@latkit/model'
import * as vscode from 'vscode'

import {
  type Bindings,
  bound,
  type Channel,
  channelsFor,
  type FieldRef,
} from '../shared/bindings.js'
import { cancelled, defect, detail, formatNumber, message } from '../shared/format.js'
import type {
  Cameras,
  Element,
  Plot,
  SimulationInfo,
  Summary,
  TableState,
  ViewState,
} from '../shared/messages.js'
import {
  defaults,
  definitions,
  type SettingsValues,
  validateSettings,
} from '../shared/preferences.js'
import { elementType, networkOf, placementOf } from '../shared/schema.js'
import { PROGRAMS } from '../shared/simulation.js'
import { Transport } from '../shared/transport.js'
import { Client } from './client.js'
import { Documents, isWritable } from './documents.js'

export interface Session {
  uri: string
  diagramEditing: boolean
  bindings: Bindings
  selection?: Element
  /** The network elements that stand for a selection the network does not draw. */
  anchors?: string[]
  run?: SimulationInfo
  previous?: SimulationInfo
  /** Whether Run was pressed and GridKit's run has not yet begun. */
  launching: boolean
  plots: Plot[]
  /** Undefined until the first parsed case supplies defaults; an empty array records nothing. */
  outputs?: FieldSelection[]
  values: Record<string, unknown>
  /** The case's playhead; views extrapolate it between changes. */
  transport: Transport
  settings: SettingsValues
  /** The Monitor's chosen time window; absent, plots show the whole run. */
  window?: readonly [number, number]
  cameras: Cameras
  table: TableState
}
/** Per-case workspace state; `recording` persists `Session.outputs`. */
type Saved = Partial<Pick<Session, 'bindings' | 'values' | 'plots' | 'table'>> & {
  recording?: FieldSelection[]
  simulationId?: string
}

/** The display settings for `uri`; an invalid value keeps its default. */
function settingsFor(uri: vscode.Uri): SettingsValues {
  const configuration = vscode.workspace.getConfiguration('gridkitStudio', uri)
  const result = { ...defaults }
  for (const { id } of definitions) {
    const value = configuration.get(id)
    if (value === undefined) continue
    try {
      Object.assign(result, validateSettings({ [id]: value }))
    } catch {
      // The user may be mid-edit.
    }
  }
  return result
}

/** What runs record until the user chooses: each bus's voltage magnitude and angle. */
export function defaultOutputs({ schema, counts }: Summary): FieldSelection[] {
  return networkOf(schema).vertices.flatMap((type) => {
    const fields = schema.types[type]!.fields
    const select = ['Vm', 'Va'].filter((field) => fields[field]?.sampled === true)
    return counts[type] && select.length ? [{ from: type, select }] : []
  })
}

/** A choice a notification offers: its label, and the command it runs. */
export interface Offer {
  title: string
  command: string
}
/** The log, where every failed run and every defect points. */
export const SHOW_OUTPUT: Offer = { title: 'Show Output', command: 'gridkitStudio.showOutput' }

/** An error to report as `text`, offering `offers`. */
export const notice = (text: string, ...offers: Offer[]) =>
  Object.assign(new Error(text), { offers })

/** How a run starts, for the log: the case, the program, its times, and a simulation's faults. */
function opening(info: SimulationInfo): string[] {
  const program = info.configuration?.program ?? 'DynamicSimulation'
  const times = info.span
    ? ` · ${formatNumber(info.span[0])} to ${formatNumber(info.span[1])} s`
    : ''
  return [
    `▶ ${info.name} · ${PROGRAMS[program]}${times}`,
    ...(program === 'DynamicSimulation'
      ? (info.configuration?.addedFaults ?? []).map(
          ({ bus, start, duration }) =>
            `  Fault at Bus ${bus} from ${formatNumber(start)} s for ${formatNumber(duration)} s`,
        )
      : []),
  ]
}

/** The plots `run` can draw: those it recorded, else its first recorded signal. */
export function plotsFor(run: SimulationInfo, plots: readonly Plot[]): Plot[] {
  const kept = plots.filter((plot) =>
    run.outputs.some(({ from, select }) => from === plot.from && select.includes(plot.field)),
  )
  const first = run.outputs.find(({ select }) => select.length > 0)
  return kept.length || !first ? kept : [{ from: first.from, field: first.select[0]! }]
}

export class Sessions {
  /** A requested setup or diagnostic command's result, also kept in the extension log. */
  inform(text: string, action?: { label: string; invoke(): unknown }) {
    this.output.info(text)
    void vscode.window
      .showInformationMessage(text, ...(action ? [action.label] : []))
      .then(async (choice) => {
        if (choice && action) {
          try {
            await action.invoke()
          } catch (error) {
            this.report(error)
          }
        }
      })
  }
  readonly client: Client
  readonly documents: Documents
  readonly all = new Map<string, Session>()
  readonly changed = new vscode.EventEmitter<string>()
  /** Fires when a case's clock changes or its following playhead moves with the head. */
  readonly clock = new vscode.EventEmitter<string>()
  readonly action = new vscode.EventEmitter<{
    uri: string
    command: string
    value?: unknown
    view?: string
  }>()
  readonly output = vscode.window.createOutputChannel('GridKit Studio', { log: true })
  /** The errors logged since the last look, so a test fails on one a user would see only in the
   *  log. */
  readonly errors: string[] = []
  readonly disposables: vscode.Disposable[] = []
  readonly contexts = new Map<string, unknown>()
  active?: string
  /** The errors already logged, so one reported twice, as a stopped worker's is, shows once. */
  readonly #logged = new WeakSet<object>()
  /** Log `reason` as an error, unless a case's diagnostic already shows it. */
  error(reason: unknown) {
    if ((reason as { diagnosed?: boolean } | undefined)?.diagnosed) return
    if (reason instanceof Object) {
      if (this.#logged.has(reason)) return
      this.#logged.add(reason)
    }
    // A defect's stack is for whoever fixes it; anything else is said as it was told.
    const text = defect(reason) || !(reason instanceof Error) ? detail(reason) : reason.message
    this.output.error(text)
    if (this.errors.push(text) > 100) this.errors.shift()
  }
  /** The errors already reported, and the notifications on show, by their text. */
  readonly #reported = new WeakSet<object>()
  readonly #showing = new Set<string>()
  /** Tell the user why something failed. This, and the log behind it, is the one place Studio
   *  says so: views show state, never failures. A defect points to the log, a notice offers its
   *  own choices, a cancellation says nothing, and an error already on show is not shown again. */
  report(reason: unknown) {
    if (cancelled(reason)) return
    if (reason instanceof Object) {
      if (this.#reported.has(reason)) return
      this.#reported.add(reason)
    }
    this.error(reason)
    const text = message(reason)
    if (this.#showing.has(text)) return
    this.#showing.add(text)
    const offers =
      (reason as { offers?: Offer[] } | null)?.offers ?? (defect(reason) ? [SHOW_OUTPUT] : [])
    void vscode.window.showErrorMessage(text, ...offers.map(({ title }) => title)).then(
      (choice) => {
        this.#showing.delete(text)
        const offer = offers.find(({ title }) => title === choice)
        if (offer) void vscode.commands.executeCommand(offer.command)
      },
      () => this.#showing.delete(text),
    )
  }
  /** The runs whose start the log has told, so it tells how each ends. */
  readonly #told = new Set<string>()
  /** The failed runs already said, so each is said once. */
  readonly #failures = new Set<string>()
  /** Tell the log how a run starts and ends, and the user, once, why one failed. */
  #narrate(info: SimulationInfo) {
    if (info.state === 'preparing') return
    if (info.state === 'running') {
      if (!this.#told.has(info.id)) {
        this.#told.add(info.id)
        for (const line of opening(info)) this.output.info(line)
      }
      return
    }
    const told = this.#told.delete(info.id)
    if (info.state === 'failed') {
      if (this.#failures.has(info.id)) return
      this.#failures.add(info.id)
      const at = info.failedAt === undefined ? '' : ` at t = ${formatNumber(info.failedAt)} s`
      const why = info.message ?? 'GridKit stopped'
      this.report(
        notice(`${info.name} failed${at}: ${why}${/[.!?]$/.test(why) ? '' : '.'}`, SHOW_OUTPUT),
      )
      return
    }
    if (!told) return
    const samples = `${info.frames.toLocaleString()} samples`
    const study = info.contingency
    if (info.state === 'complete' && study?.failed.length)
      this.report(
        notice(
          `${info.name}: ${study.failed.length} of ${study.buses.length} contingencies failed, ` +
            `at bus ${study.failed.map((n) => study.buses[n]).join(', ')}.`,
          SHOW_OUTPUT,
        ),
      )
    else if (info.state === 'complete') this.output.info(`■ ${info.name} finished · ${samples}`)
    else
      this.output.info(
        `■ ${info.name} stopped at t = ${formatNumber(info.domain[1])} s · ${samples}`,
      )
  }
  /** Register command `id`, reporting why it fails. */
  command(id: string, run: (...args: unknown[]) => unknown): vscode.Disposable {
    return vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        return await run(...args)
      } catch (error) {
        this.report(error)
      }
    })
  }
  constructor(readonly context: vscode.ExtensionContext) {
    this.client = new Client(context)
    this.documents = new Documents(this.client)
    this.disposables.push(
      this.changed.event(() => this.updateContexts()),
      // Completed recordings survive worker restarts. Unfinished simulations are interrupted.
      this.client.failure.event((error) => {
        this.report(error)
        for (const session of this.all.values()) {
          if (session.run && ['preparing', 'running'].includes(session.run.state)) {
            session.run = { ...session.run, state: 'interrupted', message: error.message }
            session.transport.setLive(false)
          }
          this.changed.fire(session.uri)
        }
      }),
      this.documents.changed.event((uri) => {
        this.changed.fire(uri)
        void this.#forget(uri)
      }),
      this.client.event.event((event) => {
        if (event.kind === 'log') {
          // A line of a case's run at its own level, and as GridKit printed it only at Trace.
          if (event.uri) {
            this.output[event.level ?? 'info'](event.message)
            if (event.raw) this.output.trace(event.raw)
          } else if (event.level === 'error') this.error(event.message)
          else if (event.level === 'warn') this.output.warn(event.message)
          else this.output.appendLine(event.message)
          return
        }
        const { info } = event
        const session = this.all.get(info.revision.uri)
        if (!session) return
        this.show(session, info)
        this.changed.fire(session.uri)
        this.#narrate(info)
      }),
      // A case's saved state follows it when it is renamed or moved, and goes when it is deleted.
      vscode.workspace.onDidRenameFiles(({ files }) => {
        for (const { oldUri, newUri } of files) this.#move(oldUri.toString(), newUri.toString())
      }),
      vscode.workspace.onDidDeleteFiles(({ files }) => {
        for (const uri of files) this.#move(uri.toString())
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        for (const session of this.all.values())
          if (event.affectsConfiguration('gridkitStudio', vscode.Uri.parse(session.uri))) {
            session.settings = settingsFor(vscode.Uri.parse(session.uri))
            this.changed.fire(session.uri)
          }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && /\.case\.json$/i.test(editor.document.fileName))
          void this.open(editor.document).catch((error) => this.error(error))
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
        if (input instanceof vscode.TabInputCustom && /\.case\.json$/i.test(input.uri.path))
          this.activate(input.uri.toString())
      }),
    )
    void this.prune()
  }
  updateContexts() {
    const session = this.active ? this.all.get(this.active) : undefined
    const entry = this.active ? this.documents.entries.get(this.active) : undefined
    const values = {
      hasCase: !!session,
      diagramEditing: !!session?.diagramEditing,
      ready: !!entry?.summary && !entry.stale,
      editable: !!entry && !entry.stale && isWritable(entry.document),
      running: session?.run?.state === 'running' || !!session?.launching,
      hasSamples: (session?.run?.frames ?? 0) > 0,
      hasSelection: !!session?.selection,
      caseReady: !!entry?.summary,
      caseFiltered: !!(session?.table.filter || session?.table.equal),
    }
    for (const [key, value] of Object.entries(values))
      if (this.contexts.get(key) !== value) {
        this.contexts.set(key, value)
        void vscode.commands.executeCommand('setContext', 'gridkitStudio.' + key, value)
      }
  }
  activate(uri: string) {
    this.active = uri
    if (!this.all.has(uri)) {
      const saved = this.context.workspaceState.get<Saved>('case:' + uri, {})
      this.all.set(uri, {
        uri,
        bindings: saved.bindings ?? {},
        plots: saved.plots ?? [],
        outputs: saved.recording,
        values: saved.values ?? {},
        transport: new Transport(() => this.clock.fire(uri)),
        launching: false,
        diagramEditing: false,
        settings: settingsFor(vscode.Uri.parse(uri)),
        cameras: {},
        table: saved.table ?? {},
      })
      if (saved.simulationId) {
        const session = this.all.get(uri)!
        void this.client.call('getSimulation', { simulationId: saved.simulationId }).then(
          (info) => {
            if (
              info.evicted ||
              session.run ||
              this.all.get(uri) !== session ||
              this.context.workspaceState.get<Saved>('case:' + uri)?.simulationId !==
                saved.simulationId
            )
              return
            this.show(session, info)
            this.changed.fire(uri)
          },
          (error) => this.output.warn('Could not restore simulation: ' + message(error)),
        )
      }
    }
    this.changed.fire(uri)
    return this.all.get(uri)!
  }
  async open(document: vscode.TextDocument) {
    const session = this.activate(document.uri.toString())
    const summary = await this.documents.ensure(document)
    if (session.outputs === undefined) {
      session.outputs = defaultOutputs(summary)
      this.changed.fire(session.uri)
    }
    return session
  }
  current() {
    const session = this.active ? this.all.get(this.active) : undefined
    if (!session) throw new Error('Open a GridKit case first.')
    return session
  }
  persist(session: Session) {
    const saved: Saved = {
      bindings: session.bindings,
      values: session.values,
      plots: session.plots,
      table: session.table,
      recording: session.outputs,
      simulationId: session.run?.contingency?.study ?? session.run?.id,
    }
    return this.context.workspaceState.update('case:' + session.uri, saved)
  }
  /** Drop the saved state of cases that no longer exist, as one deleted while VS Code was closed.
   *  A case that cannot be reached now, on a remote or network drive, keeps its state. */
  async prune() {
    const { workspaceState } = this.context
    for (const key of workspaceState.keys()) {
      if (!key.startsWith('case:')) continue
      try {
        await vscode.workspace.fs.stat(vscode.Uri.parse(key.slice('case:'.length)))
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound')
          await workspaceState.update(key, undefined)
      }
    }
  }
  /** Move the saved state of the cases at or under `from` to `to`, or drop it with no `to`. */
  #move(from: string, to?: string) {
    const { workspaceState } = this.context
    for (const key of workspaceState.keys()) {
      const uri = key.slice('case:'.length)
      if (!key.startsWith('case:') || (uri !== from && !uri.startsWith(from + '/'))) continue
      const saved = workspaceState.get<Saved>(key)
      void workspaceState.update(key, undefined)
      if (to !== undefined) void workspaceState.update('case:' + to + uri.slice(from.length), saved)
    }
  }
  state(uri: string): ViewState {
    const entry = this.documents.entries.get(uri)
    const session = this.all.get(uri)
    return {
      uri,
      version: entry?.document.version,
      writable: !!entry && isWritable(entry.document),
      diagramEditing: session?.diagramEditing,
      settings: session?.settings,
      bindings: session?.bindings,
      summary: entry?.summary,
      stale: entry?.stale,
      error: entry?.error,
      selection: session?.selection,
      anchors: session?.anchors,
      run: session?.run,
      launching: session?.launching,
      outputs: session?.outputs,
      plots: session?.plots,
      window: session?.window,
      values: session?.values,
      table: session?.table,
    }
  }
  select(uri: string, element?: Element) {
    const session = this.all.get(uri) ?? this.activate(uri)
    if (session.selection?.id === element?.id && session.selection?.field === element?.field) return
    const moved = session.selection?.id !== element?.id
    session.selection = element
    if (moved) {
      session.anchors = undefined
      if (element) void this.#anchor(session, element.id)
    }
    this.changed.fire(uri)
  }
  /** Let go of the selection once the case, read again, no longer holds its element. */
  async #forget(uri: string) {
    const session = this.all.get(uri)
    const entry = this.documents.entries.get(uri)
    const id = session?.selection?.id
    if (!id || !entry?.summary || entry.stale) return
    const { version } = entry.summary
    try {
      await this.client.call('query', {
        uri,
        version,
        query: {
          kind: 'rows',
          from: elementType(id),
          select: [],
          ids: true,
          rows: { kind: 'ids', ids: [id] },
          limit: 1,
        },
      })
    } catch {
      if (session.selection?.id === id && entry.summary?.version === version) this.select(uri)
    }
  }
  /** Find what the network draws for the selected element `id`, once the selection holds it. */
  async #anchor(session: Session, id: string) {
    const entry = this.documents.entries.get(session.uri)
    if (!entry?.summary || entry.stale) return
    const network = networkOf(entry.summary.schema)
    const drawn = [...network.vertices, ...network.edges.map((edge) => edge.type)]
    if (drawn.includes(elementType(id))) return
    try {
      const anchors = await this.client.call('anchors', {
        uri: session.uri,
        version: entry.summary.version,
        id,
        drawn,
      })
      if (session.selection?.id !== id) return
      session.anchors = anchors
      this.changed.fire(session.uri)
    } catch (error) {
      this.report(error)
    }
  }
  /** Put `run` on the session's clock: a new run resets the span, more frames of the same run
   *  extend it, and none clears it. Another contingency of the shown study keeps the time. */
  show(session: Session, run: SimulationInfo | undefined) {
    const { transport } = session
    const shown = session.run
    const study = !!run?.contingency && shown?.contingency?.study === run.contingency.study
    if (shown && run && shown.id !== run.id && !study) session.previous = shown
    session.run = run
    if (!run) {
      session.previous = undefined
      session.window = undefined
      transport.clear()
      void this.persist(session)
      return
    }
    const live = run.state === 'running'
    if (shown?.id !== run.id) {
      session.plots = plotsFor(run, session.plots)
      this.persist(session)
    }
    // A run's span starts with its first frames.
    if (shown?.id !== run.id || (shown.frames === 0 && run.frames > 0)) {
      const at = transport.currentT()
      session.window = undefined
      transport.setSpan(run.domain, { live })
      if (study) transport.seek(at)
      return
    }
    transport.extend(run.domain[1])
    if (transport.noteHead(run.domain[1])) this.clock.fire(session.uri)
    transport.setLive(live)
  }
  /** Step one frame through the shown run, then pause. */
  async step(session: Session, direction: 1 | -1) {
    if (!session.run) return
    const t = await this.client.call('step', {
      run: session.run.id,
      at: session.transport.currentT(),
      direction,
    })
    session.transport.pause()
    session.transport.seek(t)
  }
  /** Set what future runs record. Plots of the current run are unaffected; the next run keeps those
   *  it records. */
  record(uri: string, outputs: readonly FieldSelection[]) {
    const session = this.all.get(uri)
    if (!session) return
    const recorded = outputs.filter(({ select }) => select.length > 0)
    session.outputs = recorded
    // With no run, keep only the plots the next run will record.
    if (!session.run)
      session.plots = session.plots.filter((plot) =>
        recorded.some(({ from, select }) => from === plot.from && select.includes(plot.field)),
      )
    this.persist(session)
    this.changed.fire(uri)
  }
  /** Make `field` drive exactly `channels`; a mapped sampled field joins future recordings. */
  bind(
    uri: string,
    field: FieldRef,
    channels: readonly Channel[],
    domain?: readonly [number, number],
  ) {
    const session = this.all.get(uri)
    const schema = this.documents.entries.get(uri)?.summary?.schema
    if (!session || !schema) throw new Error('Open a GridKit case first.')
    const allowed = channelsFor(placementOf(networkOf(schema), field.type))
    session.bindings = bound(session.bindings, allowed, field, channels, domain)
    if (channels.length && schema.types[field.type]?.fields[field.field]?.sampled) {
      const outputs = session.outputs ?? []
      const recorded = outputs.find((output) => output.from === field.type)
      if (!recorded) session.outputs = [...outputs, { from: field.type, select: [field.field] }]
      else if (!recorded.select.includes(field.field))
        session.outputs = outputs.map((output) =>
          output === recorded ? { ...output, select: [...output.select, field.field] } : output,
        )
    }
    this.persist(session)
    this.changed.fire(uri)
  }
  async dispose() {
    for (const session of this.all.values()) {
      await this.persist(session)
      session.transport.dispose()
    }
    this.documents.dispose()
    await Promise.allSettled(this.disposables.map((disposable) => disposable.dispose()))
    this.changed.dispose()
    this.clock.dispose()
    this.action.dispose()
    this.output.dispose()
    return this.client.dispose()
  }
}
