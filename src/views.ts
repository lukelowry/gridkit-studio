import { randomBytes } from 'node:crypto'

import { type DataBatch, type Domain, type FieldSelection, staticFields } from '@latkit/model'
import * as vscode from 'vscode'

import { recordedWhole } from './bindings.js'
import {
  type FromView,
  type RunInfo,
  type Summary,
  TAIL,
  type ToView,
  type VideoView,
  type ViewKind,
  type ViewRequests,
  type ViewState,
} from './messages.js'
import { isReference, nameFieldOf, networkOf } from './schema.js'
import type { Session, Sessions } from './sessions.js'
import { type Held, holdFor } from './streams.js'
import { VideoFile } from './video.js'

/** A run's samples a view holds whole; past it the view holds a window of them. */
const WHOLE_RUN_BYTES = 48 << 20
/** The most a video export holds: every frame of what it draws, over the times it covers. */
const EXPORT_BYTES = 1 << 30
/** Results decode to float64. */
const SAMPLE_BYTES = 8
/** The views that draw the case, and so are streamed its rows and samples. */
const DRAWN: ReadonlySet<ViewKind> = new Set(['network', 'diagram', 'monitor', 'export'])
/** The commands a view may ask for. */
const COMMANDS: ReadonlySet<string> = new Set([
  'elementSource',
  'plot',
  'removePlot',
  'run',
  'stop',
])
/** What a view that draws nothing itself shows of the case; it hears of nothing else. */
const SHOWN: Partial<Record<ViewKind, (state: ViewState) => unknown>> = {
  table: ({ version, stale, writable, selection, bindings, table }) => [
    version,
    stale,
    writable,
    selection,
    bindings,
    table,
  ],
  simulation: ({ uri, stale, values, outputs, run }) => [
    uri,
    stale,
    values,
    outputs,
    run && [run.id, run.state, run.frames, run.domain, run.span, run.message],
  ],
  bindings: ({ uri, stale, bindings, editing }) => [uri, stale, bindings, editing],
}

/** What becomes of a view while it is hidden: destroyed with its webview, kept but idle, or kept
 *  at work. */
type Hidden = 'destroyed' | 'idle' | 'working'

/** What a view is streamed. */
interface Demand {
  /** The rows' identity: when it changes, they replace the case the view holds. */
  base: string
  statics: FieldSelection[]
  /** The samples' identity: while it holds, the frames a run adds are appended. */
  samples: string
  sampled: FieldSelection[]
  run?: RunInfo
  held?: Held
  maxBytes?: number
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
export class View {
  #requests = new Map<number, AbortController>()
  #summary?: Summary
  #settings?: import('./preferences.js').SettingsValues
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
  /** The demand that last failed, which is not asked for again until it changes. */
  #failed = ''
  #failure = ''
  /** Whether the view needs another look, and the look under way. */
  #again = false
  #running?: Promise<void>
  /** The newest clock change this view made itself. */
  #seq = 0
  /** The times a network holding a window of the run needs next. */
  #need?: Domain
  /** What a video export asked to hold. */
  #video?: ViewRequests['videoData']['input']
  #files = new Map<number, VideoFile>()
  #file = 0
  /** Whether the view is doing something it must not be replaced during. */
  busy = false
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
    const report = (error: unknown) => studio.output.error(String(error))
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
        if (action.uri === uri && (!action.view || action.view === kind))
          void this.send({ kind: 'action', command: action.command, value: action.value })
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
            // The view that replaces a destroyed one starts over.
            this.#ready = false
            this.cancel(true)
          }
        },
      ),
      panel.onDidDispose(() => this.dispose()),
    )
  }
  send(message: ToView) {
    return this.panel.webview.postMessage(message)
  }
  /** Tell the view the clock, settled as it is sent. */
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
        if (typeof message.element?.id === 'string') this.studio.select(this.uri, message.element)
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
      case 'bind':
        if (!session) return
        session.editing = undefined
        this.studio.bind(this.uri, message.field, message.channels, message.domain)
        return
      case 'editing':
        // Kept so the panel opens as it was left; the view that said so knows already.
        if (session) session.editing = message.field ?? undefined
        return
      case 'record':
        this.studio.record(this.uri, message.type, message.field, message.on === true)
        return
      case 'values':
        if (session && message.uri === this.uri && message.values) {
          session.values = message.values
          this.studio.persist(session)
        }
        return
      case 'tableState':
        if (!session) return
        session.table = message.table
        this.studio.persist(session)
        this.studio.updateContexts()
        if ('description' in this.panel)
          this.panel.description =
            (this.studio.state(this.uri).summary?.name ?? '') + ' · ' + (message.table.type ?? '')
        return
      case 'busy':
        this.busy = message.busy === true
        if (!this.busy) this.#video = undefined
        return
      case 'notify':
        void vscode.window.showWarningMessage(String(message.message))
        return
      case 'error':
        this.studio.output.error(message.message)
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
  /** Answer the view's request `id`, unless it gave up on it. */
  async answer(id: number, method: keyof ViewRequests, input: unknown) {
    if (this.#requests.size >= 16) {
      await this.send({ kind: 'reply', id, error: 'Too many pending requests.' })
      return
    }
    const request = new AbortController()
    this.#requests.set(id, request)
    try {
      const value = await this.handle(method, input, request.signal)
      if (!request.signal.aborted) await this.send({ kind: 'reply', id, value })
    } catch (error) {
      if (!request.signal.aborted)
        await this.send({
          kind: 'reply',
          id,
          error: error instanceof Error ? error.message : String(error),
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
      await (abort ? open?.abort() : open?.close())
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
      this.#files.set(++this.#file, file)
      return this.#file
    }
    if (method === 'videoData') {
      this.#video = input as ViewRequests['videoData']['input']
      await this.update()
      if (this.#failure) throw new Error(this.#failure)
      return studio.all.get(uri)?.cameras ?? {}
    }
    const entry = studio.documents.entries.get(uri)
    const summary = entry?.summary
    if (!summary || entry?.stale) throw new Error('The view is stale. Fix the case document first.')
    if (method === 'elements') {
      const { type } = input as ViewRequests['elements']['input']
      return studio.client.call('elements', { uri, version: summary.version, type }, signal)
    }
    if (method === 'query') {
      const query = input as ViewRequests['query']['input']
      if (
        query?.kind !== 'rows' ||
        !Number.isSafeInteger(query.limit) ||
        query.limit! < 0 ||
        query.limit! > 100
      )
        throw new Error('Invalid row query')
      // A row read at a time reads the run on show.
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
    const edit = input as ViewRequests['edit']['input']
    return studio.documents.edit(uri, edit.version, edit, edit.value)
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
    const session = this.studio.all.get(this.uri)
    const shown = SHOWN[this.kind]
    const signature = shown ? JSON.stringify(shown(state)) : undefined
    if (
      signature === undefined ||
      signature !== this.#shown ||
      state.summary !== this.#summary ||
      state.settings !== this.#settings
    ) {
      // The summary and the settings are large and change seldom: each is sent when it has.
      const sent = { ...state }
      if (state.summary === this.#summary) delete sent.summary
      if (state.settings === this.#settings) delete sent.settings
      this.#shown = signature ?? ''
      this.#summary = state.summary
      this.#settings = state.settings
      await this.send({ kind: 'state', state: sent })
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
  /** What the view draws: the rows of the types it shows, and the samples of the fields bound to
   *  the network and plotted, whole while they are few and over a window of the run past that. */
  #demand(summary: Summary, shown: RunInfo | undefined, session: Session): Demand | undefined {
    const { kind } = this
    const video = this.#video
    if (kind === 'export' && !video) return undefined
    const draws = (view: VideoView) => this.#draws(view)
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
        select: field.select.filter((name) => {
          const definition = schema.types[field.from]!
          return (
            bindings.some((binding) => binding.type === field.from && binding.field === name) ||
            name === nameFieldOf(schema, field.from) ||
            name === definition.spatial?.field ||
            isReference(definition.fields[name])
          )
        }),
      }))
      .filter((field) => field.select.length > 0)
    // The network draws only a run of the case as it stands; a plot draws whichever run is on show.
    const current = shown?.fingerprint === summary.fingerprint
    const run = draws('monitor') || current ? shown : undefined
    const base =
      (kind === 'monitor' && run ? run.fingerprint : summary.fingerprint) +
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
    if (draws('network') && current)
      for (const binding of bindings)
        if (
          schema.types[binding.type]?.fields[binding.field]?.sampled &&
          recordedWhole(shown.outputs, summary.counts[binding.type] ?? 0, binding)
        )
          add(binding.type, binding.field)
    if (draws('monitor')) for (const plot of session.plots) add(plot.from, plot.field, plot.id)
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
      ...(video && { maxBytes: EXPORT_BYTES }),
    }
  }
  /** Whether the view draws what `view` shows: itself, or a video of it. */
  #draws(view: VideoView): boolean {
    return this.kind === view || (this.kind === 'export' && !!this.#video?.views.includes(view))
  }
  /** The window of `run` the view holds: the Monitor's visible times, or the few seconds about
   *  the Network's playhead. A view at the run's head holds from there on. */
  #window(run: RunInfo, session: Session): Held {
    const { transport } = session
    const [start, end] = run.domain
    const t = transport.currentT()
    const need: Domain =
      this.kind === 'monitor'
        ? (session.window ?? [Math.max(start, end - TAIL), end])
        : (this.#need ?? [t - 1, t + 4])
    const open =
      transport.live && (this.kind === 'monitor' ? !session.window : transport.state.follow)
    return holdFor(this.#held, need, open, this.kind === 'monitor' ? need[1] - need[0] : 0)
  }
  async #streamed(summary: Summary, demand: Demand, base: boolean, append: boolean, key: string) {
    const { studio, uri } = this
    const revision = { uri, version: summary.version }
    const controller = (this.#controller = new AbortController())
    const stream = ++this.#stream
    this.#failure = ''
    try {
      await this.send({
        kind: 'begin',
        stream,
        schema: summary.schema,
        revision,
        base,
        append,
        ...(demand.held && { held: demand.held }),
        ...(base &&
          this.#draws('network') && {
            placement: await studio.client.call('placement', revision, controller.signal),
          }),
        ...(base &&
          this.#draws('diagram') && {
            presentation: await studio.client.call('presentation', revision, controller.signal),
          }),
      })
      let sequence = 0
      // One batch at a time: the next is sent once the view has taken this one.
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
          ...(demand.maxBytes && { maxBytes: demand.maxBytes }),
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
      if (controller.signal.aborted) return
      this.#failed = key
      this.#failure = error instanceof Error ? error.message : String(error)
      studio.output.error(this.#failure)
      await this.send({ kind: 'action', command: 'error', value: this.#failure })
    }
  }
  dispose() {
    this.#disposed = true
    this.cancel(true)
    for (const file of this.#files.values()) void file.abort().catch(() => {})
    this.#files.clear()
    for (const disposable of this.disposables) disposable.dispose()
  }
}
/** What each panel says before a case is open. */
const EMPTY: Record<Exclude<ViewKind, 'network' | 'diagram'>, string> = {
  table: 'Open a GridKit case to inspect its fields.',
  monitor: 'Open a GridKit case to inspect its recorded signals.',
  simulation: 'Open a GridKit case to configure and run a simulation.',
  bindings: 'Open a GridKit case to map its fields to the network.',
  export: 'Open a GridKit case to export a video of it.',
}
export function registerViews(studio: Sessions) {
  const subscriptions: vscode.Disposable[] = []
  for (const kind of ['network', 'diagram'] as const)
    subscriptions.push(
      vscode.window.registerCustomEditorProvider(
        'gridkitStudio.' + kind,
        {
          resolveCustomTextEditor(document, panel) {
            // A canvas keeps its webview while hidden, so showing it again costs nothing.
            new View(studio, panel, document.uri.toString(), kind, 'idle')
            // Let VS Code display and initialize the webview while the worker parses.
            void studio.open(document).catch((error) => studio.output.error(String(error)))
          },
        },
        {
          supportsMultipleEditorsPerDocument: true,
          webviewOptions: { retainContextWhenHidden: true },
        },
      ),
    )
  for (const kind of ['table', 'monitor', 'simulation', 'bindings', 'export'] as const) {
    // An export goes on while its panel is folded away.
    // The Monitor is hidden by every run's terminal and shown again after: it is kept, idle.
    const hidden = kind === 'export' ? 'working' : kind === 'monitor' ? 'idle' : 'destroyed'
    subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'gridkitStudio.' + kind,
        {
          resolveWebviewView(panel) {
            let content: View | undefined
            const update = () => {
              const uri = studio.active
              const name = (uri: string) =>
                studio.state(uri).summary?.name ?? vscode.Uri.parse(uri).path.split('/').at(-1)
              if (
                content &&
                (uri === content.uri || (content.busy && studio.all.has(content.uri)))
              ) {
                panel.description = name(content.uri)
                return
              }
              content?.dispose()
              content = undefined
              if (uri && studio.documents.entries.has(uri)) {
                content = new View(studio, panel, uri, kind, hidden)
                panel.description = name(uri)
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
