import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { type DataBatch, type Domain, type FieldSelection, staticFields } from '@latkit/model'
import * as vscode from 'vscode'

import { recordedWhole } from '../shared/bindings.js'
import { cancelled, defect, detail, message } from '../shared/format.js'
import {
  type FromView,
  type SimulationInfo,
  type Summary,
  type ToView,
  type VideoView,
  type ViewKind,
  type ViewRequests,
  type ViewState,
} from '../shared/messages.js'
import type { SettingsValues } from '../shared/preferences.js'
import { isReference, nameFieldOf, networkOf, positionOf, typeName } from '../shared/schema.js'
import { type Held, holdFor } from '../shared/streams.js'
import type { Session, Sessions } from './sessions.js'
import { VideoFile } from './video.js'

/** The run samples a view holds whole; past it the view holds the times around what it shows,
 *  and asks for more as it moves. */
const WHOLE_RUN_BYTES = 48 << 20
/** Results decode to float64. */
const SAMPLE_BYTES = 8
/** The views that draw the case, and so are streamed its rows and samples. */
const DRAWN: ReadonlySet<ViewKind> = new Set(['network', 'diagram', 'monitor', 'export'])
/** The commands a webview may run. */
const COMMANDS: ReadonlySet<string> = new Set([
  'elementSource',
  'plot',
  'addPlot',
  'removePlot',
  'startSimulation',
  'stopSimulation',
  'chooseSignals',
  'showContingency',
])
/** How many rows the Case panel's filters leave, by case. */
const shownRows = new Map<string, number>()

/** What a panel's title says after its name: the case, and what the panel shows of it. The Case
 *  panel's type and filtered count, and the Monitor's run, live here rather than in the panels. */
function describe(studio: Sessions, kind: ViewKind, uri: string): string {
  const { summary, table, run, launching } = studio.state(uri)
  const parts = [summary?.name ?? vscode.Uri.parse(uri).path.split('/').at(-1)]
  if (kind === 'case' && summary && table?.type) {
    parts.push(typeName(summary.schema, table.type))
    const count = summary.counts[table.type]
    const shown = shownRows.get(uri)
    if ((table.filter || table.equal) && count !== undefined && shown !== undefined)
      parts.push(`${shown.toLocaleString()} of ${count.toLocaleString()}`)
  }
  // How far a run has come, or what it left; never how it ended, which only a notification says.
  if (kind === 'simulation' && launching) parts.push('starting')
  else if ((kind === 'simulation' || kind === 'monitor') && run) {
    const study = run.contingency
    if (run.state === 'running' && kind === 'simulation')
      parts.push(
        study
          ? `${study.done.toLocaleString()} of ${study.buses.length.toLocaleString()} contingencies`
          : run.span && run.span[1] > run.span[0]
            ? `${Math.round((100 * (run.domain[1] - run.span[0])) / (run.span[1] - run.span[0]))}%`
            : 'starting',
      )
    else if (run.frames) parts.push(`${run.frames.toLocaleString()} samples`)
  }
  return parts.join(' · ')
}

/** The state each non-drawing view shows; it is sent state only when this changes. */
const SHOWN: Partial<Record<ViewKind, (state: ViewState) => unknown>> = {
  case: ({ version, stale, error, writable, selection, bindings, table }) => [
    version,
    stale,
    error,
    writable,
    selection,
    bindings,
    table,
  ],
  simulation: ({ uri, stale, error, values, outputs, run, launching }) => [
    uri,
    stale,
    error,
    values,
    outputs,
    run && [run.id, run.state, run.frames, run.domain, run.span, run.message, run.contingency],
    launching,
  ],
}

/** What happens to a hidden view's webview: destroyed, kept idle, or kept working. */
type Hidden = 'destroyed' | 'idle' | 'working'

/** What a view is streamed. */
interface Demand {
  /** Identity of the static rows; a change replaces what the view holds. */
  base: string
  statics: FieldSelection[]
  /** Identity of the sampled fields; while it holds, new frames are appended. */
  samples: string
  sampled: FieldSelection[]
  run?: SimulationInfo
  held?: Held
}

function html(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  entry: string,
  kind: string,
) {
  const nonce = randomBytes(18).toString('base64')
  const asset = (path: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, path))
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource};">
<link rel="stylesheet" href="${asset('dist/webview/' + entry + '.css')}"></head>
<body data-kind="${kind}"><div id="app"></div><script type="module" nonce="${nonce}" src="${asset('dist/webview/' + entry + '.js')}"></script></body></html>`
}
class View {
  #requests = new Map<number, AbortController>()
  #summary?: Summary
  #resultSummary?: { simulationId: string; value: Summary }
  #settings?: SettingsValues
  #shown = ''
  #ready = false
  #disposed = false
  #stream = 0
  #controller?: AbortController
  #ack?: { stream: number; sequence: number; resolve(): void; reject(error: Error): void }
  /** What the view holds: its rows, its samples, and how far into the run they reach. */
  #base?: string
  #samples = ''
  #pages = 0
  #frames = 0
  #held?: Held
  /** The last demand that failed; it is not retried until it changes. */
  #failed = ''
  #failure = ''
  /** Whether another update is due, and the update in progress. */
  #again = false
  #running?: Promise<void>
  /** The sequence number of the latest transport change this view made. */
  #seq = 0
  /** The times a network holding a window of the run needs next. */
  #need?: Domain
  /** The data a video export asked for. */
  #video?: ViewRequests['videoData']['input']
  #files = new Map<number, VideoFile>()
  #file = 0
  /** Whether the view is mid-task and must not be replaced. */
  busy = false
  #settle: () => void = () => {}
  readonly #loaded = new Promise<void>((resolve) => (this.#settle = resolve))
  readonly disposables: vscode.Disposable[] = []
  constructor(
    readonly studio: Sessions,
    readonly panel: vscode.WebviewPanel | vscode.WebviewView,
    readonly uri: string,
    readonly kind: ViewKind,
    readonly hidden: Hidden = 'destroyed',
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(studio.context.extensionUri, 'dist', 'webview')],
    }
    panel.webview.html = html(
      panel.webview,
      studio.context,
      kind === 'network' || kind === 'diagram' ? 'canvas' : kind,
      kind,
    )
    const report = (error: unknown) => studio.error(error)
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: FromView) => {
        void this.receive(message).catch(report)
      }),
      studio.changed.event((changed) => {
        if (changed === uri) void this.update().catch(report)
      }),
      studio.clock.event((changed) => {
        if (changed === uri) this.tick()
      }),
      studio.action.event((action) => {
        if (action.uri !== uri || (action.view && action.view !== kind)) return
        void this.send({ kind: 'action', command: action.command, value: action.value })
        // A reload asks again for what last failed to stream.
        if (action.command === 'retryMonitor' || action.command === 'reloadView') {
          this.#failed = ''
          void this.update().catch(report)
        }
      }),
      ('onDidChangeViewState' in panel ? panel.onDidChangeViewState : panel.onDidChangeVisibility)(
        () => {
          if (hidden === 'idle')
            void this.send({ kind: 'action', command: 'shown', value: panel.visible })
          if (panel.visible) {
            if ('active' in panel && panel.active) studio.activate(uri)
            this.tick()
            void this.update().catch(report)
          } else if (hidden === 'destroyed') {
            // The webview is destroyed; its replacement sends 'ready' again.
            this.#ready = false
            this.cancel(true)
          }
        },
      ),
      panel.onDidDispose(() => this.dispose()),
    )
  }
  send(message: ToView): Thenable<boolean> {
    // A replaced view's late messages would reach the page that took its place.
    return this.#disposed ? Promise.resolve(false) : this.panel.webview.postMessage(message)
  }
  /** Send the view a snapshot of the clock. */
  tick() {
    const session = this.studio.all.get(this.uri)
    if (!session || !this.#ready || !this.panel.visible) return
    if (this.kind === 'export' || !DRAWN.has(this.kind)) return
    void this.send({
      kind: 'clock',
      clock: session.transport.snapshot(),
      live: session.transport.live,
      seq: this.#seq,
    })
  }
  cancel(requests = false) {
    if (requests) {
      for (const controller of this.#requests.values()) controller.abort()
      this.#requests.clear()
    }
    this.#controller?.abort()
    this.#ack?.reject(new Error('View hidden or replaced'))
    this.#ack = undefined
  }
  async receive(message: FromView) {
    if (!message || typeof message !== 'object' || this.#disposed) return
    const session = this.studio.all.get(this.uri)
    switch (message.kind) {
      case 'cancel':
        this.#requests.get(message.id)?.abort()
        return
      case 'ready':
        this.cancel()
        this.#ready = true
        this.#settle()
        this.#shown = ''
        this.#base = this.#summary = this.#settings = this.#held = this.#need = undefined
        this.#samples = this.#failed = ''
        this.tick()
        await this.update()
        return
      case 'ack':
        if (this.#ack?.stream === message.stream && this.#ack.sequence === message.sequence)
          this.#ack.resolve()
        return
      case 'select':
        if (message.element === null || typeof message.element?.id === 'string')
          this.studio.select(this.uri, message.element ?? undefined)
        return
      case 'window': {
        const bounds = message.bounds
        if (!session || bounds?.length !== 2 || !bounds.every(Number.isFinite)) return
        if (!(bounds[0] < bounds[1])) return
        if (this.kind === 'monitor') session.window = [bounds[0], bounds[1]]
        else this.#need = [bounds[0], bounds[1]]
        await this.update()
        return
      }
      case 'camera':
        if (session && (this.kind === 'network' || this.kind === 'diagram'))
          session.cameras[this.kind] = message.camera
        return
      case 'transport': {
        if (!session) return
        this.#seq = message.seq
        const { transport } = session
        if (message.action === 'seek') transport.seek(Number(message.value))
        else if (message.action === 'rate') transport.setRate(Number(message.value))
        else if (message.action === 'loop') transport.setLoop(message.value)
        else if (message.action === 'playPause') transport.playPause()
        else if (message.action === 'goLive') transport.goLive()
        else if (message.action === 'step')
          await this.studio.step(session, message.value === -1 ? -1 : 1)
        return
      }
      case 'values':
        if (session && message.uri === this.uri && message.values) {
          session.values = message.values
          this.studio.persist(session)
        }
        return
      case 'tableState':
        if (!session) return
        session.table = message.table
        shownRows.set(this.uri, message.shown)
        this.studio.persist(session)
        this.studio.updateContexts()
        if ('description' in this.panel)
          this.panel.description = describe(this.studio, this.kind, this.uri)
        return
      case 'busy':
        this.busy = message.busy === true
        if (!this.busy) this.#video = undefined
        return
      case 'error':
        this.studio.report(
          Object.assign(new Error(String(message.message)), {
            detail: message.detail,
            ...(message.defect === true && { defect: true }),
          }),
        )
        return
      case 'command':
        if (COMMANDS.has(message.command)) {
          this.studio.activate(this.uri)
          await vscode.commands.executeCommand('gridkitStudio.' + message.command, message.value, {
            uri: this.uri,
            view: this.kind,
          })
        }
        return
      case 'request':
        return this.answer(message.id, message.method, message.input)
    }
  }
  /** Reply to the view's request `id` unless it was cancelled. */
  async answer(id: number, method: keyof ViewRequests, input: unknown) {
    const request = new AbortController()
    this.#requests.set(id, request)
    try {
      const work = this.handle(method, input, request.signal)
      // The Case panel's rows load under VS Code's own progress bar on the view.
      if (this.kind === 'case' && method === 'query')
        void vscode.window.withProgress({ location: { viewId: 'gridkitStudio.case' } }, () =>
          work.catch(() => {}),
        )
      const value = await work
      if (!request.signal.aborted) await this.send({ kind: 'reply', id, value })
    } catch (error) {
      if (!request.signal.aborted)
        await this.send({
          kind: 'reply',
          id,
          error: message(error),
          detail: detail(error),
          ...(defect(error) && { defect: true }),
          ...(cancelled(error) && { cancelled: true }),
        })
    } finally {
      this.#requests.delete(id)
    }
  }
  async handle(method: keyof ViewRequests, input: unknown, signal: AbortSignal): Promise<unknown> {
    const { studio, uri } = this
    if (method === 'videoWrite') {
      const { file, position, bytes } = input as ViewRequests['videoWrite']['input']
      const chunk = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
      if (!(chunk instanceof Uint8Array)) throw new Error('Invalid video write.')
      const open = this.#files.get(file)
      if (!open) throw new Error('The video file is closed.')
      return open.write(position, chunk)
    }
    if (method === 'videoClose') {
      const { file, abort } = input as ViewRequests['videoClose']['input']
      const open = this.#files.get(file)
      this.#files.delete(file)
      if (open) {
        try {
          await (abort ? open.abort() : open.close())
        } catch (error) {
          await open.abort()
          throw error
        }
      }
      return open && !abort ? open.uri.fsPath : null
    }
    if (method === 'videoOpen') {
      const { name, format } = input as ViewRequests['videoOpen']['input']
      const file = await VideoFile.choose(
        vscode.Uri.parse(uri),
        String(name),
        format === 'webm' ? 'webm' : 'mp4',
      )
      if (!file) return null
      if (signal.aborted || this.#disposed) {
        await file.abort()
        signal.throwIfAborted()
        return null
      }
      this.#files.set(++this.#file, file)
      return this.#file
    }
    if (method === 'videoData') {
      this.#video = input as ViewRequests['videoData']['input']
      await this.update()
      if (this.#failure) throw new Error(this.#failure)
      return studio.all.get(uri)?.cameras ?? {}
    }
    // A request made while the case is read again, as it is after each edit, waits for that
    // reading. A case that no longer reads keeps the view on its last revision, which says so, and
    // the request is let go: Problems says why.
    const entry = studio.documents.entries.get(uri)
    const summary = entry && (await studio.documents.ensure(entry.document).catch(() => undefined))
    if (!summary) throw new DOMException('The case does not read.', 'AbortError')
    if (method === 'elements') {
      const { type } = input as ViewRequests['elements']['input']
      return studio.client.call('elements', { uri, version: summary.version, type }, signal)
    }
    if (method === 'query') {
      const query = input as ViewRequests['query']['input']
      if (query?.kind !== 'rows') throw new Error('Invalid row query')
      // A query `at` a time reads the shown run.
      const run = query.at === undefined ? undefined : studio.all.get(uri)?.run?.id
      return studio.client.call(
        'query',
        { uri, version: summary.version, query, ...(run && { run }) },
        signal,
      )
    }
    if (method === 'transact') {
      const edit = input as ViewRequests['transact']['input']
      return studio.documents.transact(uri, edit.version, [...edit.mutations], edit.label)
    }
    throw new Error('Unknown view request: ' + method)
  }
  /** Bring the view up to date; resolves once it is. */
  update(): Promise<void> {
    this.#again = true
    return (this.#running ??= (async () => {
      try {
        while (this.#again && !this.#disposed) {
          this.#again = false
          await this.#once()
        }
      } finally {
        this.#running = undefined
      }
    })())
  }
  async #once() {
    if (!this.#ready || (!this.panel.visible && this.hidden !== 'working')) return
    const state = this.studio.state(this.uri)
    if ((this.kind === 'monitor' || this.kind === 'export') && state.run?.frames) {
      if (this.#resultSummary?.simulationId !== state.run.id)
        this.#resultSummary = {
          simulationId: state.run.id,
          value: await this.studio.client.call('describeSimulation', {
            simulationId: state.run.id,
          }),
        }
      state.summary = this.#resultSummary.value
    }
    const session = this.studio.all.get(this.uri)
    const shown = SHOWN[this.kind]
    const signature = shown ? JSON.stringify(shown(state)) : undefined
    if (
      signature === undefined ||
      signature !== this.#shown ||
      state.summary !== this.#summary ||
      state.settings !== this.#settings
    ) {
      // The summary and settings are large and change seldom; each is sent only when it changed.
      const sent = { ...state }
      if (state.summary === this.#summary) delete sent.summary
      if (state.settings === this.#settings) delete sent.settings
      this.#shown = signature ?? ''
      this.#summary = state.summary
      this.#settings = state.settings
      await this.send({ kind: 'state', state: sent })
      if (this.#disposed) return
    }
    if (!DRAWN.has(this.kind) || !state.summary || !session) return
    if (state.stale && this.kind !== 'monitor' && this.kind !== 'export') return
    const demand = this.#demand(state.summary, state.run, session)
    if (!demand) return
    const base = demand.base !== this.#base
    const append = !base && demand.samples === this.#samples
    if (append && (demand.run?.frames ?? 0) === this.#frames) return
    const key = demand.base + '\n' + demand.samples
    if (key === this.#failed) return
    await this.#streamed(state.summary, demand, base, append, key)
  }
  /** The rows the view draws, and the samples it binds or plots: the whole run while it is small,
   *  a window of it past that. */
  #demand(
    summary: Summary,
    shown: SimulationInfo | undefined,
    session: Session,
  ): Demand | undefined {
    const { kind } = this
    const video = this.#video
    if (kind === 'export' && !video) return undefined
    const { schema } = summary
    const bindings = Object.values(session.bindings)
    const network = networkOf(schema)
    const drawn =
      kind === 'network'
        ? new Set([...network.vertices, ...network.edges.map((edge) => edge.type)])
        : undefined
    const statics = staticFields(schema)
      .filter((field) => !drawn || drawn.has(field.from))
      .map((field) => ({
        ...field,
        select: field.select.filter(
          (name) =>
            bindings.some((binding) => binding.type === field.from && binding.field === name) ||
            name === nameFieldOf(schema, field.from) ||
            [positionOf(schema, field.from)?.x, positionOf(schema, field.from)?.y].includes(name) ||
            network.edges.some((edge) => edge.type === field.from && edge.bends === name) ||
            isReference(schema.types[field.from]!.fields[name]),
        ),
      }))
      .filter((field) => field.select.length > 0)
    // The network draws only a run of the current revision; plots draw whichever run is shown.
    const current = shown?.fingerprint === summary.fingerprint
    // A run's results are readable only once it reports frames; until then only the case streams.
    const run = shown?.frames && (this.#draws('monitor') || current) ? shown : undefined
    const base =
      JSON.stringify([
        summary.uri,
        summary.attachmentId,
        summary.version,
        kind === 'monitor' && run ? run.fingerprint : summary.fingerprint,
      ]) +
      ':' +
      JSON.stringify(statics)
    const fields = new Map<string, { from: string; select: string[]; ids?: string[] }>()
    const add = (from: string, field: string, id?: string) => {
      if (!run?.outputs.some((output) => output.from === from && output.select.includes(field)))
        return
      const found = fields.get(from + '\n' + field)
      if (!found)
        fields.set(from + '\n' + field, { from, select: [field], ...(id && { ids: [id] }) })
      else if (!id) delete found.ids
      else if (found.ids && !found.ids.includes(id)) found.ids.push(id)
    }
    if (this.#draws('network') && current)
      for (const binding of bindings)
        if (
          schema.types[binding.type]?.fields[binding.field]?.sampled &&
          recordedWhole(shown.outputs, summary.counts[binding.type] ?? 0, binding)
        )
          add(binding.type, binding.field)
    if (this.#draws('monitor'))
      for (const plot of session.plots) add(plot.from, plot.field, plot.id)
    const sampled = [...fields.values()].map(({ from, select, ids }): FieldSelection => ({
      from,
      select,
      ...(ids && { rows: { kind: 'ids', ids } }),
    }))
    if (!run || !sampled.length) return { base, statics, samples: '', sampled: [] }
    const bytes =
      [...fields.values()].reduce(
        (rows, { from, ids }) => rows + (ids?.length ?? summary.counts[from] ?? 0),
        0,
      ) *
      run.frames *
      SAMPLE_BYTES
    const held = video
      ? { from: video.window[0], to: video.window[1] }
      : bytes <= WHOLE_RUN_BYTES
        ? undefined
        : this.#window(run, session)
    return {
      base,
      statics,
      samples: [run.id, JSON.stringify(sampled), held?.from, held?.to].join('\n'),
      sampled,
      run,
      ...(held && { held }),
    }
  }
  /** Whether this view draws `view`, as itself or in a video export. */
  #draws(view: VideoView): boolean {
    return this.kind === view || (this.kind === 'export' && !!this.#video?.views.includes(view))
  }
  /** The window of `run` to hold: the Monitor's visible times, or a few seconds around the
   *  playhead. A view following the run's head holds an open-ended window. */
  #window(run: SimulationInfo, session: Session): Held {
    const { transport } = session
    const [start, end] = run.domain
    const t = transport.currentT()
    const need: Domain =
      this.kind === 'monitor'
        ? (session.window ?? run.span ?? [start, end])
        : (this.#need ?? [t - 1, t + 4])
    // The default Monitor interval is fixed. Finishing a run must not replace its entire
    // history merely to close the stream's upper bound.
    const open =
      this.kind === 'monitor' ? !session.window : transport.live && transport.state.follow
    return holdFor(this.#held, need, open, this.kind === 'monitor' ? need[1] - need[0] : 0)
  }
  async #streamed(summary: Summary, demand: Demand, base: boolean, append: boolean, key: string) {
    const { studio, uri } = this
    const revision = { uri, version: summary.version, attachmentId: summary.attachmentId }
    const controller = (this.#controller = new AbortController())
    const stream = ++this.#stream
    this.#failure = ''
    try {
      await this.send({
        kind: 'begin',
        fields: [...demand.statics, ...demand.sampled],
        simulationId: demand.run?.id,
        stream,
        schema: summary.schema,
        revision,
        base,
        append,
        ...(demand.held && { held: demand.held }),
        sampled: demand.sampled,
        ...(base &&
          this.#draws('diagram') && {
            presentation: await studio.client.call('presentation', revision, controller.signal),
          }),
      })
      let sequence = 0
      // Backpressure: the next batch waits for the view to ack this one.
      const consume = async (batches: readonly DataBatch[]) => {
        controller.signal.throwIfAborted()
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.#ack = undefined
            reject(new Error('View consumption timed out'))
          }, 10000)
          this.#ack = {
            stream,
            sequence: ++sequence,
            resolve: () => {
              clearTimeout(timer)
              this.#ack = undefined
              resolve()
            },
            reject: (error) => {
              clearTimeout(timer)
              reject(error)
            },
          }
          void this.send({ kind: 'batch', stream, sequence, batches }).then((posted) => {
            if (!posted) this.#ack?.reject(new Error('View closed'))
          })
        })
      }
      const { held, run } = demand
      const { pages } = await studio.client.call(
        'batches',
        {
          ...revision,
          fields: [...demand.statics, ...demand.sampled],
          includeStatic: base,
          ...(run && {
            run: run.id,
            fromPage: append ? this.#pages : 0,
            ...(held && { window: [held.from, held.to ?? Infinity] as const }),
          }),
        },
        controller.signal,
        consume,
      )
      controller.signal.throwIfAborted()
      await this.send({ kind: 'end', stream })
      this.#base = demand.base
      this.#samples = demand.samples
      this.#pages = pages
      this.#frames = run?.frames ?? 0
      this.#held = held
    } catch (error) {
      if (controller.signal.aborted || this.#disposed) return
      // A run cleared or replaced while it streamed is no failure: the view asks for what shows now.
      if (demand.run && studio.all.get(uri)?.run?.id !== demand.run.id) return
      if (!demand.run && studio.state(uri).summary?.version !== revision.version) return
      this.#failed = key
      this.#failure = message(error)
      studio.report(error)
    }
  }
  /** Whether its page is on screen and still loading: replacing it now breaks VS Code's loader. */
  get loading(): boolean {
    return !this.#ready && this.panel.visible
  }
  /** Settles once its page has loaded, it is disposed, or a few seconds pass. */
  get loaded(): Promise<void> {
    return Promise.race([this.#loaded, delay(5000)])
  }
  dispose() {
    this.#settle()
    this.#disposed = true
    this.cancel(true)
    for (const file of this.#files.values()) void file.abort().catch(() => {})
    this.#files.clear()
    for (const disposable of this.disposables) disposable.dispose()
  }
}
/** Each panel's placeholder while no case is open. */
const EMPTY: Record<Exclude<ViewKind, 'network' | 'diagram'>, string> = {
  case: 'Open a GridKit case to inspect its fields.',
  monitor: 'Open a GridKit case to inspect its recorded signals.',
  simulation: 'Open a GridKit case to configure a simulation.',
  export: 'Open a GridKit case to export a video of it.',
}
/** The side bar and panel views VS Code has shown, by kind. */
const resolved = new Map<ViewKind, vscode.WebviewView>()

/** Show view `kind` without taking focus from where the user is. One never shown yet can only be
 *  shown by focusing it. */
export async function showView(kind: 'case' | 'monitor' | 'simulation' | 'export') {
  const view = resolved.get(kind)
  if (view) view.show(true)
  else await vscode.commands.executeCommand('gridkitStudio.' + kind + '.focus')
}

export function registerViews(studio: Sessions) {
  const subscriptions: vscode.Disposable[] = []
  for (const kind of ['network', 'diagram'] as const)
    subscriptions.push(
      vscode.window.registerCustomEditorProvider(
        'gridkitStudio.' + kind,
        {
          resolveCustomTextEditor(document, panel) {
            // A canvas keeps its webview while hidden, so showing it again is free.
            new View(studio, panel, document.uri.toString(), kind, 'idle')
            // Not awaited, so the webview loads while the worker parses.
            void studio.open(document).catch((error) => studio.error(error))
          },
        },
        {
          supportsMultipleEditorsPerDocument: true,
          webviewOptions: { retainContextWhenHidden: true },
        },
      ),
    )
  for (const kind of ['case', 'monitor', 'simulation', 'export'] as const) {
    // An export keeps working while its panel is collapsed. The Case panel takes the Monitor's
    // place in the bottom panel, so the Monitor is kept idle rather than destroyed.
    const hidden = kind === 'export' ? 'working' : kind === 'monitor' ? 'idle' : 'destroyed'
    subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'gridkitStudio.' + kind,
        {
          resolveWebviewView(panel) {
            resolved.set(kind, panel)
            let content: View | undefined
            let waiting = false
            const update = () => {
              const uri = studio.active
              if (
                content &&
                (uri === content.uri || (content.busy && studio.all.has(content.uri)))
              ) {
                panel.description = describe(studio, kind, content.uri)
                return
              }
              // Another case waits for this one's page to load before taking its place.
              if (content?.loading) {
                if (!waiting) {
                  waiting = true
                  void content.loaded.then(() => {
                    waiting = false
                    update()
                  })
                }
                return
              }
              content?.dispose()
              content = undefined
              if (
                uri &&
                (studio.documents.entries.has(uri) ||
                  ((kind === 'monitor' || kind === 'export') && studio.all.get(uri)?.run))
              ) {
                content = new View(studio, panel, uri, kind, hidden)
                panel.description = describe(studio, kind, uri)
              } else {
                panel.webview.html =
                  '<!doctype html><html lang="en"><body style="font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding:12px">' +
                  EMPTY[kind] +
                  '</body></html>'
                panel.description = undefined
              }
            }
            const changed = studio.changed.event(update)
            const visibility = panel.onDidChangeVisibility(update)
            panel.onDidDispose(() => {
              if (resolved.get(kind) === panel) resolved.delete(kind)
              changed.dispose()
              visibility.dispose()
              content?.dispose()
            })
            update()
          },
        },
        { webviewOptions: { retainContextWhenHidden: hidden !== 'destroyed' } },
      ),
    )
  }
  return subscriptions
}
