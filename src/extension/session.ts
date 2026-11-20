/** Per-case state: view state, the results the views draw and the run that writes them. A session
 *  lives while it has at least one hold, and its saved state outlives it. */

import * as vscode from 'vscode'

import { randomUUID } from '../platform/crypto.js'
import { nameOf } from '../platform/path.js'
import { fileKey } from '../results/index.js'
import { changedTable } from '../shared/cells.js'
import type { ValueRange } from '../shared/data.js'
import { type Entity, type Field, networkRole, sameField } from '../shared/document.js'
import { defect, failedWith, message, quiet } from '../shared/errors.js'
import { formatNumber } from '../shared/format.js'
import { isCaseFile, savedKey, savedUri } from '../shared/ids.js'
import {
  type Channel,
  channelsFor,
  keptMappings,
  mapped,
  type Mappings,
} from '../shared/mappings.js'
import {
  type Element,
  type Framing,
  type Monitor,
  type Results,
  type ResultsLayout,
  type ResultsProgress,
  type Revision,
  revisionOf,
  type Run,
  type RunRequest,
  type Summary,
  type TableState,
} from '../shared/messages.js'
import { shownOf, signalsOf } from '../shared/monitors.js'
import type { ExportSettings, ViewSettings } from '../shared/settings.js'
import { Transport } from '../shared/transport.js'
import { isDiagnosed, noCase, notice, SHOW_OUTPUT } from './report.js'
import { displayOf, exportOf } from './settings.js'
import { gone, writtenNow } from './solvers.js'
import type { Studio } from './studio.js'
import { uriOf } from './uris.js'

/** Why a session is kept: an open editor, the active case, a run, or an export. */
export type Hold = 'document' | 'active' | 'run' | 'export'

/** Per-case state kept in workspace storage. */
interface Saved {
  readonly mappings?: Mappings
  /** The monitors given an element or a value range. */
  readonly monitors?: Monitor[]
  /** The monitors the Monitor shows. */
  readonly shown?: Field[]
  readonly table?: TableState
  /** The results file the Monitor showed, and the solver file whose run wrote it. */
  readonly results?: { readonly path: string; readonly solver?: string }
}

export function savedResults(state: vscode.Memento): string[] {
  return state.keys().flatMap((key) => {
    const path = savedUri(key) === undefined ? undefined : state.get<Saved>(key)?.results?.path
    return path ? [path] : []
  })
}

/** A run request without the parts the session fills in. */
type RunPlan = Omit<RunRequest, keyof Revision | 'run' | 'results'>

/** Whether `results` were read to the end of their file and stopped short with an error. */
const unread = (results?: Results) => !!results?.error && !results.growing

/** The monitors and those shown, with what they derive from. They are rebuilt only when that
 *  changes, so views are sent them only then. */
interface MonitorList {
  readonly outputs?: Results['outputs']
  readonly listed?: Summary['recording']['listed']
  readonly options: Monitor[]
  readonly shown: Field[]
  readonly monitors: Monitor[]
  readonly visible: Monitor[]
}

/** A run in progress. Worker events carry its id, so events from an earlier run are ignored. */
interface Running {
  readonly id: string
  readonly results: string
  readonly stop: AbortController
  /** Whether the worker reported it started; until then, the run ends with its request. */
  began: boolean
  written?: Results
  readonly wrote: (results: Results) => void
  readonly ended: (run?: Run) => void
}

export class Session {
  readonly transport: Transport
  readonly #studio: Studio
  readonly #holds = new Set<Hold>()
  #closed = false
  #moved = false
  /** A results file to read again: the saved one, or the one shown when the worker stopped. */
  #pending?: Saved['results']
  /** When to read `#pending`: once the case is active, or once the case file reads. */
  #due?: 'following' | 'read'
  /** The latest results loaded or cleared. A file read for an older claim is not shown. */
  #claim: object = {}
  /** The run whose results replace the shown ones once its file has a header. Another claim stops
   *  it, and a run that never writes changes nothing. */
  #claimant?: Running
  #settings: ViewSettings
  #exportSettings: ExportSettings
  #mappings: Mappings
  #options: Monitor[]
  #shown: Field[]
  #listed?: MonitorList
  #table: TableState
  #rows?: number
  #selection?: Element
  #networkSelection?: readonly Entity[]
  #framing?: Framing
  #window?: readonly [number, number]
  #results?: Results
  /** The case the shown results were read against, fetched once per results. */
  #described?: { readonly results: string; summary?: Summary }
  #run?: Run
  #running?: Running
  /** The last step requested, which the next one waits on. */
  #steps: Promise<void> = Promise.resolve()
  /** The latest load; an older one still reading is discarded. */
  #loading?: object

  constructor(
    readonly uri: string,
    studio: Studio,
  ) {
    this.#studio = studio
    const saved = studio.context.workspaceState.get<Saved>(savedKey(uri), {})
    this.#mappings = saved.mappings ?? {}
    this.#options = saved.monitors ?? []
    this.#shown = saved.shown ?? []
    this.#table = saved.table ?? {}
    this.#pending = saved.results
    if (saved.results) this.#due = 'following'
    this.#settings = displayOf(vscode.Uri.parse(uri))
    this.#exportSettings = exportOf(vscode.Uri.parse(uri))
    this.transport = new Transport(() => studio.clock.fire(uri))
  }

  /** Adopts the state saved under the case's old name, for a session created under the new name
   *  before the rename event arrived. */
  resume(saved: unknown): void {
    const { mappings, monitors, shown, table, results } = (saved ?? {}) as Saved
    this.#mappings = mappings ?? this.#mappings
    this.#options = monitors ?? this.#options
    this.#shown = shown ?? this.#shown
    this.#table = table ?? this.#table
    if (results && !this.#results && !this.#pending) {
      this.#pending = results
      this.#due = 'following'
      this.restore('following')
    }
    const summary = this.#studio.files.get(this.uri)?.summary
    if (summary) this.reconcile(summary)
    this.#save()
    this.#changed()
  }

  /** Makes the saved view state true to the case as it now reads. A mapping, sort or value filter
   *  on a field the case no longer has is dropped, as the selection of an element that is gone is.
   *  Otherwise the views would keep asking for that field, and nothing could remove it. The read
   *  itself tells the views. */
  reconcile(summary: Summary): void {
    const mappings = keptMappings(summary.definition, this.#mappings)
    const table = changedTable(summary, this.#table, {})
    const sameTable = JSON.stringify(table) === JSON.stringify(this.#table)
    if (mappings === this.#mappings && sameTable) return
    this.#mappings = mappings
    if (!sameTable) this.#table = table
    this.#save()
  }

  get settings(): ViewSettings {
    return this.#settings
  }
  get exportSettings(): ExportSettings {
    return this.#exportSettings
  }
  get mappings(): Mappings {
    return this.#mappings
  }
  /** One monitor per signal the shown results hold, or before any, the case records. */
  get monitors(): readonly Monitor[] {
    return this.#monitorList().monitors
  }
  /** The monitors the Monitor shows, in list order: those chosen, else the first. */
  get shown(): readonly Monitor[] {
    return this.#monitorList().visible
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
  get networkSelection(): readonly Entity[] | undefined {
    return this.#networkSelection
  }
  get framing(): Framing | undefined {
    return this.#framing
  }
  get window(): readonly [number, number] | undefined {
    return this.#window
  }
  get results(): Results | undefined {
    return this.#results
  }
  get described(): Summary | undefined {
    const described = this.#described
    return described?.results === this.#results?.id ? described?.summary : undefined
  }
  get run(): Run | undefined {
    return this.#run
  }
  get running(): boolean {
    return this.#running !== undefined
  }
  /** Whether the claiming run is still writing the shown results. The clock, playback controls
   *  and views read only this. */
  get live(): boolean {
    const claimant = this.#claimant
    const results = this.#results
    return !!claimant && results?.id === claimant.results && results.growing
  }
  /** Whether the results file at `path` is shown, or about to be shown again. */
  shows(path: string): boolean {
    const held = this.#results?.path ?? this.#pending?.path
    return held !== undefined && fileKey(held) === fileKey(path)
  }

  /** Adds a hold. A closed session throws, and the caller asks Studio for a new one. */
  hold(why: Hold): void {
    if (this.#closed) throw noCase()
    this.#holds.add(why)
    if (why === 'active') this.restore('following')
  }

  /** Reads `#pending` again when it is due for `because` and the case is active. */
  restore(because: 'following' | 'read'): void {
    if (!this.#due || !this.#holds.has('active')) return
    if (because === 'read' && this.#due !== 'read') return
    this.#due = undefined
    void this.#restore()
  }

  release(why: Hold): void {
    if (this.#holds.delete(why) && !this.#holds.size) this.#close()
  }

  /** Shows `results` and closes the previous ones. New results reset the clock span, more frames
   *  of the same results extend it, and none clears it. The only way the shown results change. */
  show(results: Results | undefined): void {
    if (this.#closed) {
      if (results) this.#studio.closeResults(results.id)
      return
    }
    const previous = this.#results
    const dropped = this.#pending !== undefined
    this.#pending = this.#due = undefined
    if (!results && !previous) {
      if (dropped) this.#save()
      return
    }
    if (previous && previous.id !== results?.id) this.#studio.closeResults(previous.id)
    this.#results = results
    if (!results) this.#described = undefined
    else if (this.#described?.results !== results.id) void this.#describe(results.id)
    const saving = previous?.id !== results?.id
    const { transport, live } = this
    if (!results) {
      this.#window = undefined
      transport.clear()
    } else {
      // The span starts with the first frames. A live run puts the playhead at the head, since a
      // fast run may send nothing more. A finished run puts it at the end.
      if (previous?.id !== results.id || (previous.frames === 0 && results.frames > 0)) {
        this.#window = undefined
        transport.setSpan(results.domain, { live })
        if (live) transport.grow(results.domain[1])
        else if (this.#running?.results === results.id) transport.seek(results.domain[1])
      } else {
        transport.grow(results.domain[1])
        transport.setLive(live)
      }
      if (unread(results) && !(previous?.id === results.id && unread(previous)))
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

  /** Starts a new claim: stops the claiming run and drops any pending read. */
  #claimed(): object {
    this.#claimant?.stop.abort()
    this.#claimant = undefined
    this.#pending = this.#due = undefined
    return (this.#claim = {})
  }

  /** Reads and shows the results file at `path`, written by `solver`'s run when given. A file that
   *  fails to read changes nothing, and a newer load or claim wins. */
  async load(path: string, solver?: string, signal?: AbortSignal): Promise<void> {
    const claim = this.#claim
    const loading = (this.#loading = {})
    const results = await this.#read(path, solver, signal)
    if (this.#loading !== loading || this.#claim !== claim) {
      this.#studio.closeResults(results.id)
      return
    }
    this.#claimed()
    this.show(results)
  }

  /** Closes the shown results and stops a run writing them; the file stays. */
  clear(): void {
    this.#claimed()
    this.show(undefined)
  }

  /** Applies read progress for the results `id`, shown or written by the session's run. The run's
   *  results replace the shown ones once they have outputs, while the run has the claim. */
  reading(id: string, progress: ResultsProgress, layout?: ResultsLayout): void {
    const running = this.#running?.results === id ? this.#running : undefined
    const known = running ? running.written : this.#results?.id === id ? this.#results : undefined
    const base = layout ?? known
    if (!base) return
    const results: Results = { ...base, ...progress, id }
    if (running) running.wrote((running.written = results))
    if (
      running ? this.#claimant === running && results.outputs.length > 0 : this.#results?.id === id
    )
      this.show(results)
  }

  /** Runs GridKit and resolves with how the run ended; `wrote` gets its progress. The session is
   *  held for the run. Stop Simulation, Clear Results and opening other results stop it. */
  async start(
    plan: RunPlan,
    signal: AbortSignal,
    wrote: (results: Results) => void = () => {},
  ): Promise<Run | undefined> {
    if (this.#running) throw new Error(`${nameOf(this.uri)} is already running.`)
    this.hold('run')
    let ended!: (run?: Run) => void
    const end = new Promise<Run | undefined>((resolve) => (ended = resolve))
    const running: Running = {
      id: randomUUID(),
      results: randomUUID(),
      stop: new AbortController(),
      began: false,
      wrote,
      ended,
    }
    this.#running = this.#claimant = running
    try {
      await this.#studio.withCase(this.uri, (revision) =>
        this.#studio.client.worker.call(
          'run',
          { ...revision, ...plan, run: running.id, results: running.results },
          AbortSignal.any([signal, running.stop.signal]),
        ),
      )
    } catch (error) {
      // Once the worker started the run, its final event ends it, even when stopped.
      if (!running.began) {
        this.#end(running)
        throw error
      }
    }
    return end
  }

  stop(): void {
    this.#running?.stop.abort()
  }

  /** Applies a worker event for the current run; events for other runs are ignored. */
  ran(next: Run): void {
    const running = this.#running
    if (next.id !== running?.id) return
    this.#run = next
    const { output } = this.#studio.reporter
    if (next.state === 'running') {
      if (!running.began) {
        running.began = true
        output.info(`▶ ${next.command}`)
      }
      return this.#changed()
    }
    const { written } = running
    if (next.state === 'failed') {
      const why = next.message ?? 'GridKit stopped'
      this.#studio.reporter.report(
        notice(`${next.command} failed: ${why}${/[.!?]$/.test(why) ? '' : '.'}`, SHOW_OUTPUT),
      )
    } else {
      const samples = `${(written?.frames ?? 0).toLocaleString()} samples`
      output.info(
        next.state === 'complete'
          ? `■ ${next.command} finished (${samples})`
          : `■ ${next.command} stopped at t = ${formatNumber(written?.domain[1] ?? 0)} s (${samples})`,
      )
    }
    this.#end(running, next)
  }

  /** Ends `running`, closing its results unless shown and releasing the run's hold. */
  #end(running: Running, run?: Run): void {
    if (this.#running !== running) return
    this.#running = undefined
    if (this.#claimant === running) this.#claimant = undefined
    if (this.#results?.id !== running.results) this.#studio.closeResults(running.results)
    this.transport.setLive(this.live)
    running.ended(run)
    this.#changed()
    this.release('run')
  }

  /** The worker stopped: interrupts a started run and reads the results again under a new id.
   *  Results the worker was still reading, which may have crashed it, wait for Reload View. */
  lost(error: Error): void {
    const reading = !!this.#results?.growing || (!!this.#pending && !this.#due)
    // No final event will come for a run the worker started.
    if (this.#running?.began && this.#run)
      this.ran({ ...this.#run, state: 'interrupted', message: error.message })
    this.#readAgain(!reading)
  }

  /** The worker dropped the results `id`; reads them again from their file now. */
  dropped(id: string): void {
    if (this.#results?.id === id) this.#readAgain(true)
  }

  /** Reads the shown or pending results again, now if `now`, else once the case is active again. */
  #readAgain(now: boolean): void {
    const current = this.#results
    if (current) {
      // The worker no longer has them, so there is nothing to close.
      this.#results = this.#described = undefined
      this.#pending = { path: current.path, ...(current.solver && { solver: current.solver }) }
      this.#window = undefined
      this.transport.clear()
      this.#changed()
    }
    if (!this.#pending) return
    this.#due = 'following'
    if (now) this.restore('following')
  }

  /** Steps one frame and pauses. Steps are chained, so a held key steps through every frame. */
  step(direction: 1 | -1): Promise<void> {
    const stepped = this.#steps.then(() => this.#step(direction))
    this.#steps = stepped.catch(() => {})
    return stepped
  }

  async #step(direction: 1 | -1): Promise<void> {
    const results = this.#results
    if (!results) return
    const t = await this.#studio.client.worker.call('step', {
      results: results.id,
      at: this.transport.currentT(),
      direction,
    })
    // Results shown since then have their own playhead.
    if (this.#results !== results) return
    this.transport.pause()
    this.transport.seek(t)
  }

  select(element?: Element): void {
    if (
      this.#selection?.table === element?.table &&
      this.#selection?.id === element?.id &&
      this.#selection?.field === element?.field
    )
      return
    const moved = this.#selection?.table !== element?.table || this.#selection?.id !== element?.id
    this.#selection = element
    if (moved) {
      this.#networkSelection = undefined
      if (element) this.#selectInNetwork(element)
    }
    this.#changed()
  }

  /** After the case reads again: clears the selection if its element is gone, else resolves its
   *  Network selection again, since its ports may have changed. */
  async reselect(): Promise<void> {
    const entity = this.#selection
    const { summary, stale } = this.#studio.files.get(this.uri) ?? {}
    if (!entity || !summary || stale) return
    let exists: boolean
    try {
      const page = await this.#studio.client.worker.call('page', {
        revision: revisionOf(summary),
        request: { table: entity.table, fields: [], ids: [entity.id], offset: 0, limit: 1 },
      })
      exists = page.ids.length > 0
    } catch (error) {
      // A type the case no longer has means the element is gone.
      if (!failedWith(error, 'invalid-input') && !failedWith(error, 'invalid')) {
        if (defect(error)) this.#studio.reporter.report(error)
        return
      }
      exists = false
    }
    if (
      this.#selection !== entity ||
      this.#studio.files.get(this.uri)?.summary?.version !== summary.version
    )
      return
    if (!exists) this.select()
    else {
      this.#selectInNetwork(entity)
      this.#changed()
    }
  }

  /** Maps `field` to exactly `channels`, over `range` or, without one, the field's own values. */
  map(field: Field, channels: readonly Channel[], range?: ValueRange): void {
    const definition = this.#studio.files.get(this.uri)?.summary?.definition
    if (!definition) throw noCase()
    const allowed = channelsFor(networkRole(definition, field.table))
    this.#mappings = mapped(this.#mappings, allowed, field, channels, range)
    this.#save()
    this.#changed()
  }

  /** Shows only `monitor`, as clicking a terminal in the Terminal's list does. */
  showMonitor(monitor: Field): void {
    this.#setShown([monitor])
  }

  /** Shows `monitor` beside those shown. */
  split(monitor: Field): void {
    if (!this.shown.some((each) => sameField(each, monitor)))
      this.#setShown([...this.shown, monitor])
  }

  /** Stops showing `monitor` beside the others; the last one shown stays. */
  unsplit(monitor: Field): void {
    const rest = this.shown.filter((each) => !sameField(each, monitor))
    if (rest.length) this.#setShown(rest)
  }

  /** Shows the monitor `step` places after the first one shown, wrapping around the list. */
  cycle(step: 1 | -1): void {
    const { monitors, shown } = this
    if (!monitors.length) return
    const at = shown[0] ? monitors.findIndex((each) => sameField(each, shown[0]!)) : 0
    this.showMonitor(monitors[(at + step + monitors.length) % monitors.length]!)
  }

  /** Sets a monitor's element and value range. */
  setMonitor(monitor: Monitor): void {
    const rest = this.#options.filter((each) => !sameField(each, monitor))
    this.#options = monitor.id !== undefined || monitor.range ? [...rest, monitor] : rest
    this.#save()
    this.#changed()
  }

  #setShown(shown: readonly Field[]): void {
    this.#shown = shown.map(({ table, field }) => ({ table, field }))
    this.#save()
    this.#changed()
  }

  #monitorList(): MonitorList {
    const outputs = this.#results?.outputs
    const listed = this.#studio.files.get(this.uri)?.summary?.recording.listed
    const cached = this.#listed
    if (
      cached &&
      cached.outputs === outputs &&
      cached.listed === listed &&
      cached.options === this.#options &&
      cached.shown === this.#shown
    )
      return cached
    const monitors = signalsOf(outputs && { outputs }, listed).map(
      (field) => this.#options.find((each) => sameField(each, field)) ?? field,
    )
    const visible = shownOf(monitors, this.#shown)
    // Unchanged lists keep their identity, so views are not sent them again.
    const same = <T>(previous: T[] | undefined, next: T[]) =>
      previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next
    return (this.#listed = {
      outputs,
      listed,
      options: this.#options,
      shown: this.#shown,
      monitors: same(cached?.monitors, monitors),
      visible: same(cached?.visible, visible),
    })
  }

  setWindow(window?: readonly [number, number]): void {
    this.#window = window && [window[0], window[1]]
    this.#changed()
  }

  /** The only writer of the Case panel's state; `save` is false while typing a filter. The panel
   *  renders what it is sent, so changes made while it is hidden appear when it opens. */
  setTable(change: Partial<TableState>, save = true): void {
    const summary = this.#studio.files.get(this.uri)?.summary
    const table = changedTable(summary, this.#table, change)
    const same = JSON.stringify(table) === JSON.stringify(this.#table)
    this.#table = table
    if (save) this.#save()
    if (!same) this.#changed()
  }

  /** Sets the filtered row count shown in the Case panel's title; not saved. */
  setRows(rows: number): void {
    if (rows === this.#rows) return
    this.#rows = rows
    this.#changed()
  }

  setFraming(framing: Framing | undefined): void {
    this.#framing = framing
  }

  /** Reads the settings again. Each part is replaced only when it changed, so the views that do
   *  not read it keep what they draw. */
  reconfigure(): void {
    const uri = vscode.Uri.parse(this.uri)
    const settings = displayOf(uri)
    const exportSettings = exportOf(uri)
    const views = JSON.stringify(settings) !== JSON.stringify(this.#settings)
    const exports = JSON.stringify(exportSettings) !== JSON.stringify(this.#exportSettings)
    if (views) this.#settings = settings
    if (exports) this.#exportSettings = exportSettings
    if (views || exports) this.#changed()
  }

  /** The case was renamed, moved or deleted, so stop saving under the old name. */
  moved(): void {
    this.#moved = true
  }

  dispose(): void {
    this.#save()
    this.transport.dispose()
  }

  /** Reads `#pending` again, taking a solver's results from where its solver file writes now.
   *  If the case does not read, waits until it does. A missing file is forgotten; one that fails
   *  to read is kept for the next start. */
  async #restore(): Promise<void> {
    const saved = this.#pending
    if (!saved) return
    let summary: Summary
    try {
      summary = await this.#studio.files.read(this.uri)
    } catch {
      // The case's own failure is already reported.
      if (this.#pending === saved) this.#due = 'read'
      return
    }
    let path = saved.path
    try {
      path = (saved.solver && (await writtenNow(saved.solver, summary))) || saved.path
      const results = await this.#read(path, saved.solver)
      if (this.#pending === saved) this.show(results)
      else this.#studio.closeResults(results.id)
    } catch (error) {
      if (this.#pending !== saved) return
      if (isDiagnosed(error)) {
        this.#due = 'read'
        return
      }
      this.#studio.reporter.output.warn(`Could not read ${path} again: ${message(error)}`)
      if ((await gone(uriOf(path))) && this.#pending === saved) {
        this.#pending = undefined
        this.#save()
      }
    }
  }

  /** Opens `path` in the worker under a new id, open until the session closes it. */
  async #read(path: string, solver?: string, signal?: AbortSignal): Promise<Results> {
    const results = randomUUID()
    try {
      return await this.#studio.withCase(this.uri, (revision) =>
        this.#studio.client.worker.call(
          'open',
          { ...revision, results, path, ...(solver && { solver }) },
          signal,
        ),
      )
    } catch (error) {
      // The reply may have crossed with the cancellation.
      this.#studio.closeResults(results)
      throw error
    }
  }

  /** Reload View: retries the case file, pending results and the unanswered describe request. */
  retry(): void {
    this.#studio.files.retry(this.uri)
    this.restore('following')
    const current = this.#results
    if (current && !this.#described) void this.#describe(current.id)
  }

  async #describe(id: string): Promise<void> {
    const described: { results: string; summary?: Summary } = { results: id }
    this.#described = described
    try {
      described.summary = await this.#studio.client.worker.call('describe', { results: id })
      if (this.#described === described) this.#changed()
    } catch (error) {
      if (this.#described === described) this.#described = undefined
      // Results closed while the worker answered are not an error.
      if (!quiet(error)) this.#studio.reporter.report(error)
    }
  }

  /** Resolves the entity itself when the Network draws its type, else asks the worker. */
  #selectInNetwork(entity: Entity): void {
    const { summary, stale } = this.#studio.files.get(this.uri) ?? {}
    if (!summary || stale) return
    if (networkRole(summary.definition, entity.table)) {
      this.#networkSelection = [{ table: entity.table, id: entity.id }]
      return
    }
    const asked = { ...revisionOf(summary), entity }
    void this.#studio.client.worker.call('networkSelection', asked).then(
      (selection) => {
        if (this.#selection?.table !== entity.table || this.#selection?.id !== entity.id) return
        this.#networkSelection = selection
        this.#changed()
      },
      // A case read again meanwhile is not an error: the selection resolves again.
      (error: unknown) => {
        if (!quiet(error)) this.#studio.reporter.report(error)
      },
    )
  }

  #close(): void {
    this.#closed = true
    this.#save()
    this.transport.dispose()
    // A run holds the session, so none is in progress here.
    if (this.#results) this.#studio.closeResults(this.#results.id)
    this.#results = undefined
    this.#studio.closed(this)
  }

  /** Saves view state and the shown results file, or the pending one until it is replaced. */
  #save(): void {
    if (this.#moved || !isCaseFile(this.uri)) return
    const current = this.#results
    const results = current
      ? { path: current.path, ...(current.solver && { solver: current.solver }) }
      : this.#pending
    const saved: Saved = {
      mappings: this.#mappings,
      monitors: this.#options,
      shown: this.#shown,
      table: this.#table,
      ...(results && { results }),
    }
    void this.#studio.context.workspaceState.update(savedKey(this.uri), saved)
  }

  #changed(): void {
    this.#studio.changed.fire(this.uri)
  }
}
