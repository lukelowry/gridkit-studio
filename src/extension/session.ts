/** A case Studio works on, in every process: what its views show of it, the results they draw, and
 *  the run that writes them. Something always holds a session while it lives: an editor has its
 *  case open, the views follow it, a run writes for it, or an export draws it. When the last lets
 *  go, it closes, and lets go of all it holds, here and in the results worker. What it saves stays,
 *  to open with again. */

import { randomUUID } from 'node:crypto'

import * as vscode from 'vscode'

import {
  type Bindings,
  bound,
  type Channel,
  channelsFor,
  type FieldRef,
} from '../shared/bindings.js'
import { message } from '../shared/errors.js'
import { formatNumber } from '../shared/format.js'
import { savedKey } from '../shared/ids.js'
import type {
  Cameras,
  CaseSource,
  Element,
  Plot,
  Results,
  Run,
  RunRequest,
  TableState,
  ViewKind,
} from '../shared/messages.js'
import { plotsFor, samePlot } from '../shared/plots.js'
import type { SettingsValues } from '../shared/preferences.js'
import { elementType, networkOf, placementOf } from '../shared/schema.js'
import { Transport } from '../shared/transport.js'
import { noCase, notice, SHOW_OUTPUT } from './report.js'
import type { Sessions } from './sessions.js'
import { displayOf } from './settings.js'
import { nameOf, writtenNow } from './solvers.js'

/** Why a session is kept: an editor has its case open, the views follow it, a run writes for it,
 *  or an export draws it. */
export type Hold = 'document' | 'active' | 'run' | 'export'

/** What a session saves for its case, to open with again. */
interface Saved {
  readonly bindings?: Bindings
  readonly plots?: Plot[]
  readonly table?: TableState
  /** The results file the Monitor showed, and the solver file whose run wrote it. */
  readonly results?: { readonly path: string; readonly solver?: string }
}

/** What a run of the session's case takes besides the case: the solver file, where it writes, when
 *  it ends, the folder a container mounts, and where GridKit runs. */
export type RunPlan = Omit<RunRequest, keyof CaseSource | 'results'>

/** Whether `results` were read to their end and stopped short of it. */
const unread = (results?: Results) => !!results?.error && !results.growing

export class Session {
  readonly transport: Transport
  readonly #studio: Sessions
  readonly #holds = new Set<Hold>()
  #closed = false
  /** Whether the results it saved have been read again, which they are once, as the views first
   *  follow it. */
  #restored = false
  /** The results file it saved, until it is read again or other results take its place. */
  #pending?: Saved['results']
  #settings: SettingsValues
  #bindings: Bindings
  #plots: Plot[]
  #table: TableState
  /** How many rows the Case panel's filters leave. */
  #rows?: number
  #selection?: Element
  /** The network elements that stand for a selection the network does not draw. */
  #anchors?: string[]
  #diagramEditing = false
  #cameras: Cameras = {}
  /** The Monitor's chosen time window; absent, plots show the whole run. */
  #window?: readonly [number, number]
  /** The results file the views draw: a run's, or one opened. */
  #results?: Results
  /** The latest run of the case. */
  #run?: Run
  /** The run under way: what stops it, and the results it writes until they are let go of. */
  #running?: { readonly stop: AbortController; results?: string }

  constructor(
    readonly uri: string,
    studio: Sessions,
  ) {
    this.#studio = studio
    const saved = studio.context.workspaceState.get<Saved>(savedKey(uri), {})
    this.#bindings = saved.bindings ?? {}
    this.#plots = saved.plots ?? []
    this.#table = saved.table ?? {}
    this.#pending = saved.results
    this.#settings = displayOf(vscode.Uri.parse(uri))
    this.transport = new Transport(() => studio.clock.fire(uri))
  }

  get settings(): SettingsValues {
    return this.#settings
  }
  get bindings(): Bindings {
    return this.#bindings
  }
  get plots(): readonly Plot[] {
    return this.#plots
  }
  get table(): TableState {
    return this.#table
  }
  get rows(): number | undefined {
    return this.#rows
  }
  get selection(): Element | undefined {
    return this.#selection
  }
  get anchors(): readonly string[] | undefined {
    return this.#anchors
  }
  get diagramEditing(): boolean {
    return this.#diagramEditing
  }
  get cameras(): Cameras {
    return this.#cameras
  }
  get window(): readonly [number, number] | undefined {
    return this.#window
  }
  get results(): Results | undefined {
    return this.#results
  }
  get run(): Run | undefined {
    return this.#run
  }
  /** Whether a run of the case is under way. */
  get running(): boolean {
    return this.#running !== undefined
  }

  /** Keeps the session for `why`. The views following it first read again the results it saved. */
  hold(why: Hold): void {
    this.#holds.add(why)
    if (why === 'active' && !this.#restored) {
      this.#restored = true
      void this.#restore()
    }
  }

  /** Lets go of the session for `why`; once nothing holds it, it closes. */
  release(why: Hold): void {
    if (this.#holds.delete(why) && !this.#holds.size) this.#close()
  }

  /** Puts `results` on show, and on the session's clock, letting go of those shown before: new
   *  results start the span over, more frames of the same extend it, and none clears it. While they
   *  are `live`, as a run writes them, the playhead follows their frames as they come. The one way
   *  the results on show change. */
  show(results: Results | undefined, live = false): void {
    if (this.#closed) {
      if (results) this.#studio.closeResults(results.id)
      return
    }
    // Whatever shows now takes the place of the results saved before.
    this.#pending = undefined
    const shown = this.#results
    if (!results && !shown) return
    if (shown && shown.id !== results?.id) this.#studio.closeResults(shown.id)
    this.#results = results
    /** Whether what it saves changed: other results, or the plots they hold. */
    let saving = shown?.id !== results?.id
    const { transport } = this
    if (!results) {
      this.#window = undefined
      transport.clear()
    } else {
      // The fields are the file's header, which GridKit writes after the run starts.
      if (results.outputs.length && (shown?.id !== results.id || !shown.outputs.length)) {
        this.#plots = plotsFor(results, this.#plots)
        saving = true
      }
      // The span starts with the first frames, and a live head is already where they reach: a run
      // that finishes fast sends no frames after these.
      if (shown?.id !== results.id || (shown.frames === 0 && results.frames > 0)) {
        this.#window = undefined
        transport.setSpan(results.domain, { live })
        if (live) transport.grow(results.domain[1])
      } else {
        transport.grow(results.domain[1])
        transport.setLive(live)
      }
      if (unread(results) && !(shown?.id === results.id && unread(shown)))
        this.#studio.reporter.report(
          notice(
            `${results.name} could not be read past ${results.frames.toLocaleString()} ` +
              `samples: ${results.error}`,
            SHOW_OUTPUT,
          ),
        )
    }
    if (saving) this.#save()
    this.#changed()
  }

  /** Reads the results file at `path`, which `solver`'s run wrote when it names one, and shows it. */
  async load(path: string, solver?: string, signal?: AbortSignal): Promise<void> {
    this.show(await this.#read(path, solver, signal))
  }

  /** Lets go of the results on show, stopping a run that writes them. Their file stays. */
  clear(): void {
    if (this.#running) {
      this.#running.results = undefined
      this.#running.stop.abort()
    }
    this.show(undefined)
  }

  /** Takes the latest of the results the worker reads for the case: those on show, or those the
   *  session's run writes, which take their place and are followed live. */
  reading(results: Results): void {
    const writing = this.#running?.results === results.id && this.#run?.state === 'running'
    if (writing || this.#results?.id === results.id) this.show(results, writing)
  }

  /** Runs GridKit as `plan` says, holding the session until the run ends. Its results replace those
   *  on show as they come; Stop Simulation and Clear Results stop it. */
  async start(plan: RunPlan, signal: AbortSignal): Promise<Run> {
    if (this.#running) throw new Error(`${nameOf(vscode.Uri.parse(this.uri))} is already running.`)
    const results = randomUUID()
    const running = (this.#running = { stop: new AbortController(), results })
    this.hold('run')
    try {
      return await this.#studio.withCase(this.uri, (source) =>
        this.#studio.client.results.call(
          'run',
          { ...source, ...plan, results },
          AbortSignal.any([signal, running.stop.signal]),
        ),
      )
    } finally {
      if (this.#running === running) this.#running = undefined
      // Results the run wrote and nothing shows are let go of.
      if (this.#results?.id !== results) this.#studio.closeResults(results)
      this.release('run')
    }
  }

  /** Stops the run under way. */
  stop(): void {
    this.#running?.stop.abort()
  }

  /** Takes the latest state of the session's run: a run's start lets go of the results on show,
   *  and the log hears how it starts and ends, and the user, once, why it failed. */
  ran(next: Run): void {
    const before = this.#run
    this.#run = next
    const { output } = this.#studio.reporter
    if (next.state === 'running') {
      if (before?.id !== next.id) {
        output.info(`▶ ${next.command}`)
        this.show(undefined)
      }
      return this.#changed()
    }
    const ended = before?.id === next.id && before.state === 'running'
    const written = this.#results?.id === this.#running?.results ? this.#results : undefined
    if (written) this.transport.setLive(false)
    if (next.state === 'failed') {
      if (before?.id !== next.id || before.state !== 'failed') {
        const why = next.message ?? 'GridKit stopped'
        this.#studio.reporter.report(
          notice(`${next.command} failed: ${why}${/[.!?]$/.test(why) ? '' : '.'}`, SHOW_OUTPUT),
        )
      }
    } else if (ended) {
      const samples = `${(written?.frames ?? 0).toLocaleString()} samples`
      output.info(
        next.state === 'complete'
          ? `■ ${next.command} finished · ${samples}`
          : `■ ${next.command} stopped at t = ${formatNumber(written?.domain[1] ?? 0)} s · ${samples}`,
      )
    }
    this.#changed()
  }

  /** The results worker stopped. A run under way was interrupted, and what was on show is read
   *  again from its file, as far as it was written, under an id the views start over with: at once
   *  while the views follow the session, unless `steady` says the worker keeps stopping, else once
   *  they follow it again. */
  lost(error: Error, steady: boolean): void {
    if (this.#run?.state === 'running')
      this.ran({ ...this.#run, state: 'interrupted', message: error.message })
    const shown = this.#results
    if (!shown) return
    // The worker holds them no more, so there is nothing to let go of.
    this.#results = undefined
    this.#pending = { path: shown.path, ...(shown.solver && { solver: shown.solver }) }
    this.#restored = steady && this.#holds.has('active')
    if (this.#restored) void this.#restore()
    else {
      this.#window = undefined
      this.transport.clear()
      this.#changed()
    }
  }

  /** Steps one frame through the results on show, then pauses. */
  async step(direction: 1 | -1): Promise<void> {
    if (!this.#results) return
    const t = await this.#studio.client.results.call('step', {
      results: this.#results.id,
      at: this.transport.currentT(),
      direction,
    })
    this.transport.pause()
    this.transport.seek(t)
  }

  /** Selects `element`, or nothing. A selection of an element the Network does not draw finds what
   *  stands for it there. */
  select(element?: Element): void {
    if (this.#selection?.id === element?.id && this.#selection?.field === element?.field) return
    const moved = this.#selection?.id !== element?.id
    this.#selection = element
    if (moved) {
      this.#anchors = undefined
      if (element) void this.#anchor(element.id)
    }
    this.#changed()
  }

  /** Lets go of the selection once the case, read again, no longer holds its element. */
  async forget(): Promise<void> {
    const id = this.#selection?.id
    const { summary, stale } = this.#studio.documents.get(this.uri) ?? {}
    if (!id || !summary || stale) return
    try {
      await this.#studio.client.cases.call('query', {
        uri: this.uri,
        version: summary.version,
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
      if (
        this.#selection?.id === id &&
        this.#studio.documents.get(this.uri)?.summary?.version === summary.version
      )
        this.select()
    }
  }

  /** Makes `field` drive exactly `channels`, over `domain` when given. */
  bind(field: FieldRef, channels: readonly Channel[], domain?: readonly [number, number]): void {
    const schema = this.#studio.documents.get(this.uri)?.summary?.schema
    if (!schema) throw noCase()
    const allowed = channelsFor(placementOf(networkOf(schema), field.type))
    this.#bindings = bound(this.#bindings, allowed, field, channels, domain)
    this.#save()
    this.#changed()
  }

  /** Shows the plots `plots` in the Monitor, and no others. */
  setPlots(plots: readonly Plot[]): void {
    this.#plots = [...plots]
    this.#save()
    this.#changed()
  }

  /** Shows `plot` in the Monitor, after those it shows. */
  addPlot(plot: Plot): void {
    if (!this.#plots.some((each) => samePlot(each, plot))) this.setPlots([...this.#plots, plot])
  }

  removePlot(plot: Plot): void {
    this.setPlots(this.#plots.filter((each) => !samePlot(each, plot)))
  }

  /** Plots `plot`'s field of the element `id` alone. */
  plotElement(plot: Plot, id: string): void {
    this.setPlots(this.#plots.map((each) => (samePlot(each, plot) ? { ...each, id } : each)))
  }

  /** Shows `window` in the Monitor; with none, the whole run. */
  setWindow(window?: readonly [number, number]): void {
    this.#window = window && [window[0], window[1]]
    this.#changed()
  }

  /** What the Case panel shows, and, when it says, how many rows its filters leave. The panel says
   *  so with every page it reads, so only a change is saved and heard. */
  setTable(table: TableState, rows = this.#rows): void {
    if (rows === this.#rows && JSON.stringify(table) === JSON.stringify(this.#table)) return
    this.#table = table
    this.#rows = rows
    this.#save()
    this.#changed()
  }

  setEditing(editing: boolean): void {
    if (this.#diagramEditing === editing) return
    this.#diagramEditing = editing
    this.#changed()
  }

  /** How the Network or Diagram was last framed, for an export to keep. */
  setCamera(kind: Extract<ViewKind, 'network' | 'diagram'>, camera: unknown): void {
    this.#cameras = { ...this.#cameras, [kind]: camera }
  }

  /** Reads its display settings again, as they change. */
  reconfigure(): void {
    this.#settings = displayOf(vscode.Uri.parse(this.uri))
    this.#changed()
  }

  /** Saves what it saves, and stops its clock, as the extension stops. */
  dispose(): void {
    this.#save()
    this.transport.dispose()
  }

  /** Reads again the results file the Monitor last showed: a simulation's from where its solver
   *  file writes now, when that file is there. Results shown meanwhile, as a run started, show
   *  instead; a file that no longer reads is forgotten. */
  async #restore(): Promise<void> {
    const saved = this.#pending
    if (!saved) return
    try {
      const { summary } = await this.#studio.caseOf(this.uri)
      const path = (saved.solver && (await writtenNow(saved.solver, summary))) || saved.path
      const results = await this.#read(path, saved.solver)
      if (this.#pending === saved) this.show(results)
      else this.#studio.closeResults(results.id)
    } catch (error) {
      this.#studio.reporter.output.warn(`Could not read ${saved.path} again: ${message(error)}`)
      if (this.#pending === saved) {
        this.#pending = undefined
        this.#save()
      }
    }
  }

  /** Reads the results file at `path`, which `solver`'s run wrote when it names one, into results
   *  of an id the session chose: the worker holds them until the session lets go of them. */
  async #read(path: string, solver?: string, signal?: AbortSignal): Promise<Results> {
    const results = randomUUID()
    try {
      return await this.#studio.withCase(this.uri, (source) =>
        this.#studio.client.results.call(
          'open',
          { ...source, results, path, ...(solver && { solver }) },
          signal,
        ),
      )
    } catch (error) {
      // Its answer may have crossed with its cancellation.
      this.#studio.closeResults(results)
      throw error
    }
  }

  /** Finds what the network draws for the selected element `id`. */
  async #anchor(id: string): Promise<void> {
    const summary = this.#studio.documents.get(this.uri)?.summary
    if (!summary || this.#studio.documents.get(this.uri)?.stale) return
    const network = networkOf(summary.schema)
    const drawn = [...network.vertices, ...network.edges.map((edge) => edge.type)]
    if (drawn.includes(elementType(id))) return
    try {
      const anchors = await this.#studio.client.cases.call('anchors', {
        uri: this.uri,
        version: summary.version,
        id,
        drawn,
      })
      if (this.#selection?.id !== id) return
      this.#anchors = anchors
      this.#changed()
    } catch (error) {
      this.#studio.reporter.report(error)
    }
  }

  #close(): void {
    this.#closed = true
    this.#save()
    this.transport.dispose()
    this.#running?.stop.abort()
    if (this.#results) this.#studio.closeResults(this.#results.id)
    this.#results = undefined
    this.#studio.closed(this)
  }

  /** Saves the session's mappings, plots, table, and the results file on show, or, until it is
   *  read again or replaced, the one it saved before. */
  #save(): void {
    const shown = this.#results
    const results = shown
      ? { path: shown.path, ...(shown.solver && { solver: shown.solver }) }
      : this.#pending
    const saved: Saved = {
      bindings: this.#bindings,
      plots: this.#plots,
      table: this.#table,
      ...(results && { results }),
    }
    void this.#studio.context.workspaceState.update(savedKey(this.uri), saved)
  }

  #changed(): void {
    this.#studio.changed.fire(this.uri)
  }
}
