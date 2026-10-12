import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

import type { Block, Query } from '@latkit/model'
import * as vscode from 'vscode'

import { errorOf, quiet } from '../shared/errors.js'
import { commandId, VIEW_COMMANDS, viewId } from '../shared/ids.js'
import type {
  FromView,
  Results,
  Summary,
  ToView,
  ViewApi,
  ViewKind,
  ViewState,
} from '../shared/messages.js'
import type { SettingsValues } from '../shared/preferences.js'
import { type Answerer, answerer, type Handlers } from '../shared/rpc.js'
import { typeName } from '../shared/schema.js'
import { packed } from './packed.js'
import { noCase } from './report.js'
import type { Sessions } from './sessions.js'
import { VideoFiles } from './video.js'

/** The views a clock moves. */
const CLOCKED: ReadonlySet<ViewKind> = new Set(['network', 'monitor'])
/** The views in VS Code's panels, which follow the case the views follow. */
const PANELS = ['case', 'monitor', 'export'] as const
type Panel = (typeof PANELS)[number]

/** What a panel's title says after its name: the case, and what the panel shows of it. The Case
 *  panel's type and filtered count, and the Monitor's results, live here rather than in the
 *  panels. */
function describe(studio: Sessions, kind: ViewKind, uri: string): string {
  const { summary, table, results } = studio.state(uri)
  const parts = [summary?.name ?? vscode.Uri.parse(uri).path.split('/').at(-1)]
  if (kind === 'case' && summary && table?.type) {
    parts.push(typeName(summary.schema, table.type))
    const count = summary.counts[table.type]
    const shown = studio.get(uri)?.rows
    if ((table.filter || table.equal) && count !== undefined && shown !== undefined)
      parts.push(`${shown.toLocaleString()} of ${count.toLocaleString()}`)
  }
  // What a run left, never how it ended, which only a notification says. How far one has come is
  // its notification's to say.
  if (kind === 'monitor' && results) {
    if (results.solver) parts.push(basename(results.solver))
    if (results.frames) parts.push(`${results.frames.toLocaleString()} samples`)
  }
  return parts.join(' · ')
}

/** What of the results a view draws: which, how far they are read, what they hold, and the times
 *  and values they span. */
const drawn = (results?: Results) =>
  results && [
    results.id,
    results.frames,
    // A file's outputs are fixed once its header is read: whether they are is all that changes, so
    // their row indexes are never written out again.
    results.outputs.length,
    results.domain,
    results.span,
    results.domains,
  ]

/** What each view reads of the state, besides the summary and settings, which are compared on
 *  their own; a view is sent state only when this changes. While a run writes, the frames read so
 *  far send a view that draws them state again, which is how it hears there are more to ask for. */
const SHOWN: Record<ViewKind, (state: ViewState) => unknown> = {
  case: ({ uri, version, stale, error, writable, selection, bindings, table }) => [
    uri,
    version,
    stale,
    error,
    writable,
    selection,
    bindings,
    table,
  ],
  diagram: ({ uri, stale, error, writable, selection, anchors, bindings, diagramEditing }) => [
    uri,
    stale,
    error,
    writable,
    selection,
    anchors,
    bindings,
    diagramEditing,
  ],
  // The times the results hold mark which ones the network can draw, and their ranges color it.
  network: ({ uri, stale, error, writable, selection, anchors, bindings, results }) => [
    uri,
    stale,
    error,
    writable,
    selection,
    anchors,
    bindings,
    drawn(results),
  ],
  // Results the plots show have a fixed span while a run writes them, else the times they hold.
  monitor: ({ uri, stale, selection, bindings, plots, window, results }) => [
    uri,
    stale,
    selection,
    bindings,
    plots,
    window,
    drawn(results),
    results?.growing,
  ],
  // An export's times follow the results' until the user chooses their own.
  export: ({ uri, stale, error, bindings, plots, results }) => [
    uri,
    stale,
    error,
    bindings,
    plots,
    drawn(results),
  ],
}

/** What happens to a hidden view's webview: destroyed, kept idle, or kept working. */
type Hidden = 'destroyed' | 'idle' | 'working'

function html(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  entry: string,
  kind: string,
) {
  const nonce = randomBytes(18).toString('base64')
  const asset = (path: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, path))
  // The map's worker starts from a blob, and its tiles come from wherever the tiles URL names.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource} https:;">
<link rel="stylesheet" href="${asset('dist/webview/' + entry + '.css')}"></head>
<body data-kind="${kind}"><div id="app"></div><script type="module" nonce="${nonce}" src="${asset('dist/webview/' + entry + '.js')}"></script></body></html>`
}

/** One webview of Studio's and the case it shows: a canvas editor's own, or the case a panel
 *  follows. Its page loads once, and follows another case by the state it is sent. */
class View {
  readonly #answering: Answerer
  readonly #videos = new VideoFiles()
  #uri?: string
  #summary?: Summary
  /** The case the shown results were read against, as it was then. */
  #described?: { results: string; summary: Summary }
  #settings?: SettingsValues
  #shown = ''
  #ready = false
  #disposed = false
  /** Whether another update is due, and the update in progress. */
  #again = false
  #running?: Promise<void>
  /** The sequence number of the latest transport change this view made. */
  #seq = 0
  /** The case the view works on while it is mid-task, as an export is, which it keeps till done. */
  #working?: string
  /** Hears once the view is done with its task. */
  onIdle?: () => void
  readonly #report: (error: unknown) => void
  readonly disposables: vscode.Disposable[] = []
  constructor(
    readonly studio: Sessions,
    readonly panel: vscode.WebviewPanel | vscode.WebviewView,
    readonly kind: ViewKind,
    readonly hidden: Hidden,
    uri?: string,
  ) {
    this.#uri = uri
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
    // Results closed while the view asked of them, or a revision a newer one replaced, are no
    // failure: newer state follows.
    const report = (error: unknown) => {
      if (!quiet(error)) studio.reporter.error(error)
    }
    this.#report = report
    this.#answering = answerer(this.#handlers(), (reply) => void this.send(reply))
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: FromView) => {
        void this.receive(message).catch(report)
      }),
      studio.changed.event((changed) => {
        if (changed === this.#uri) void this.update().catch(report)
      }),
      studio.clock.event((changed) => {
        if (changed === this.#uri) this.tick()
      }),
      studio.action.event((action) => {
        if (action.uri !== this.#uri || (action.view && action.view !== kind)) return
        void this.send({ kind: 'action', command: action.command, value: action.value })
      }),
      ('onDidChangeViewState' in panel ? panel.onDidChangeViewState : panel.onDidChangeVisibility)(
        () => {
          if (hidden === 'idle')
            void this.send({ kind: 'action', command: 'shown', value: panel.visible })
          if (panel.visible) {
            if ('active' in panel && panel.active && this.#uri) studio.activate(this.#uri)
            this.tick()
            void this.update().catch(report)
          } else if (hidden === 'destroyed') {
            // The webview is destroyed; its replacement sends 'ready' again.
            this.#ready = false
            this.cancel()
          }
        },
      ),
      panel.onDidDispose(() => this.dispose()),
    )
  }

  /** The case the view shows. */
  get uri(): string | undefined {
    return this.#uri
  }

  /** Whether the view is mid-task, and must keep the case it works on. */
  get busy(): boolean {
    return this.#working !== undefined
  }

  /** Shows the case at `uri`, or none: what it showed of another starts over. */
  follow(uri: string | undefined) {
    if (uri === this.#uri) return
    this.#uri = uri
    this.cancel()
    this.#shown = ''
    this.#summary = this.#settings = this.#described = undefined
    this.tick()
    void this.update().catch(this.#report)
  }

  send(message: ToView): Thenable<boolean> {
    // A disposed view's late messages would reach a page that took its place.
    return this.#disposed ? Promise.resolve(false) : this.panel.webview.postMessage(packed(message))
  }

  /** Sends the view a snapshot of the clock. */
  tick() {
    const session = this.#uri && this.studio.get(this.#uri)
    if (!session || !this.#ready || !this.panel.visible) return
    if (!CLOCKED.has(this.kind)) return
    void this.send({
      kind: 'clock',
      clock: session.transport.snapshot(),
      live: session.transport.live,
      seq: this.#seq,
    })
  }

  /** Lets go of the view's requests under way. */
  cancel() {
    this.#answering.cancel()
  }

  /** The case the view shows, which a request needs. */
  #need(): string {
    if (!this.#uri) throw noCase()
    return this.#uri
  }

  async receive(message: FromView) {
    if (!message || typeof message !== 'object' || this.#disposed) return
    const session = this.#uri ? this.studio.get(this.#uri) : undefined
    switch (message.kind) {
      case 'request':
      case 'cancel':
        return this.#answering.receive(message)
      case 'ready':
        this.#ready = true
        this.#shown = ''
        this.#summary = this.#settings = undefined
        this.tick()
        await this.update()
        return
      case 'select':
        if (message.element === null || typeof message.element?.id === 'string')
          session?.select(message.element ?? undefined)
        return
      case 'window': {
        const bounds = message.bounds
        if (this.kind !== 'monitor' || !session || bounds?.length !== 2) return
        if (!bounds.every(Number.isFinite) || !(bounds[0] < bounds[1])) return
        session.setWindow(bounds)
        return
      }
      case 'camera':
        if (this.kind === 'network' || this.kind === 'diagram')
          session?.setCamera(this.kind, message.camera)
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
        else if (message.action === 'step') await session.step(message.value === -1 ? -1 : 1)
        return
      }
      case 'tableState':
        if (!session) return
        session.setTable(message.table, message.shown)
        if ('description' in this.panel)
          this.panel.description = describe(this.studio, this.kind, session.uri)
        return
      case 'busy':
        return this.#work(message.busy === true ? this.#uri : undefined)
      case 'error': {
        const { problem, context } = message
        this.studio.reporter.report(
          Object.assign(errorOf(problem), {
            detail: `[${this.kind}] ${problem.code} ${JSON.stringify(context ?? {})}\n${problem.detail ?? problem.message}`,
          }),
        )
        return
      }
      case 'command':
        if (VIEW_COMMANDS.includes(message.command) && this.#uri) {
          this.studio.activate(this.#uri)
          await vscode.commands.executeCommand(commandId(message.command), message.value, {
            uri: this.#uri,
            view: this.kind,
          })
        }
        return
    }
  }

  /** Works on the case at `uri` till done, which holds its session; with none, is done. */
  #work(uri: string | undefined) {
    if (uri === this.#working) return
    const done = this.#working
    this.#working = uri
    if (uri) this.studio.hold(uri, 'export')
    if (done) {
      this.studio.release(done, 'export')
      this.onIdle?.()
    }
  }

  /** What the view may ask: of the case it shows, the results it draws, and the videos it exports.
   *  It asks for what it lacks of the case and the results: the case's revision names what it asks
   *  of, and is refused once stale. */
  #handlers(): Handlers<ViewApi> {
    const { studio } = this
    const { client } = studio
    /** The case as it reads now. A request made while the case is read again, as it is after each
     *  edit, waits for that reading. A case that no longer reads keeps the view on its last
     *  revision, which says so, and the request is let go: Problems says why. */
    const read = async (uri: string) => {
      const entry = studio.documents.get(uri)
      const summary = entry && (await studio.documents.parsed(entry.document))
      if (!summary) throw new DOMException('The case does not read.', 'AbortError')
      return summary
    }
    /** Rows of the case, or, `at` a time, of the shown results. */
    const query = async (query: Query.Rows, signal: AbortSignal) => {
      if (query?.kind !== 'rows') throw new Error('Invalid row query')
      const uri = this.#need()
      const results = query.at === undefined ? undefined : studio.get(uri)?.results?.id
      const blocks = results
        ? await client.results.call('query', { results, query }, signal)
        : await client.cases.call(
            'query',
            { uri, version: (await read(uri)).version, query },
            signal,
          )
      return blocks.filter((block): block is Block.Rows => block.kind === 'rows')
    }
    return {
      samples: (input, signal) => client.results.call('samples', input, signal),
      rows: (input, signal) =>
        'results' in input
          ? client.results.call('rows', input, signal)
          : client.cases.call('rows', input, signal),
      presentation: (input, signal) =>
        'results' in input
          ? client.results.call('presentation', input, signal)
          : client.cases.call('presentation', input, signal),
      query: (input, signal) => {
        const rows = query(input, signal)
        // The Case panel's rows load under VS Code's own progress bar on the view.
        if (this.kind === 'case')
          void vscode.window.withProgress({ location: { viewId: viewId('case') } }, () =>
            rows.catch(() => {}),
          )
        return rows
      },
      transact: async ({ version, mutations, label }) => {
        const uri = this.#need()
        await read(uri)
        return studio.documents.transact(uri, version, [...mutations], label)
      },
      cameras: async () => studio.get(this.#need())?.cameras ?? {},
      videoOpen: ({ name, format }, signal) =>
        this.#videos.open(vscode.Uri.parse(this.#need()), name, format, signal),
      videoWrite: ({ file, position, bytes }) => this.#videos.write(file, position, bytes),
      videoClose: ({ file, abort }) => this.#videos.close(file, abort),
    }
  }

  /** Brings the view up to date; resolves once it is. */
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
    // A hidden view catches up when it shows; one kept working works on while hidden.
    if (!this.#ready || (!this.panel.visible && !(this.hidden === 'working' && this.busy))) return
    const state: ViewState = this.#uri ? this.studio.state(this.#uri) : {}
    if ((this.kind === 'monitor' || this.kind === 'export') && state.results?.frames) {
      const results = state.results.id
      if (this.#described?.results !== results)
        this.#described = {
          results,
          summary: await this.studio.client.results.call('describe', { results }),
        }
      state.summary = this.#described.summary
    }
    const signature = JSON.stringify(SHOWN[this.kind](state))
    if (
      signature !== this.#shown ||
      state.summary !== this.#summary ||
      state.settings !== this.#settings
    ) {
      // The summary and settings are large and change seldom; each is sent only when it changed.
      const sent = { ...state }
      if (state.summary === this.#summary) delete sent.summary
      if (state.settings === this.#settings) delete sent.settings
      this.#shown = signature
      this.#summary = state.summary
      this.#settings = state.settings
      await this.send({ kind: 'state', state: sent })
    }
  }

  dispose() {
    this.#disposed = true
    this.cancel()
    this.#work(undefined)
    this.#videos.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }
}

/** The panel views VS Code has shown, by kind. */
const resolved = new Map<Panel, vscode.WebviewView>()

/** Shows `kind` without taking focus from where the user is. A panel never shown yet, and
 *  Monitored Signals, can only be shown by focusing them. */
export async function showView(kind: Panel | 'signals') {
  const view = kind === 'signals' ? undefined : resolved.get(kind)
  if (view) view.show(true)
  else await vscode.commands.executeCommand(viewId(kind) + '.focus')
}

export function registerViews(studio: Sessions) {
  const subscriptions: vscode.Disposable[] = []
  for (const kind of ['network', 'diagram'] as const)
    subscriptions.push(
      vscode.window.registerCustomEditorProvider(
        viewId(kind),
        {
          resolveCustomTextEditor(document, panel) {
            // A canvas keeps its webview while hidden, so showing it again is free.
            new View(studio, panel, kind, 'idle', document.uri.toString())
            // Not awaited, so the webview loads while the worker parses.
            void studio.open(document).catch((error) => studio.reporter.error(error))
          },
        },
        {
          supportsMultipleEditorsPerDocument: true,
          webviewOptions: { retainContextWhenHidden: true },
        },
      ),
    )
  for (const kind of PANELS) {
    // An export keeps working while its panel is collapsed. The Case panel takes the Monitor's
    // place in the bottom panel, so the Monitor is kept idle rather than destroyed.
    const hidden = kind === 'export' ? 'working' : kind === 'monitor' ? 'idle' : 'destroyed'
    subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        viewId(kind),
        {
          resolveWebviewView(panel) {
            resolved.set(kind, panel)
            const view = new View(studio, panel, kind, hidden)
            /** The panel follows the case the views follow, unless it works on another. */
            const follow = () => {
              if (!view.busy) view.follow(studio.active)
              panel.description = view.uri && describe(studio, kind, view.uri)
            }
            view.onIdle = follow
            // Only the case it shows, or the one it is to show, changes what it shows.
            const changed = studio.changed.event((uri) => {
              if (uri === view.uri || uri === studio.active) follow()
            })
            panel.onDidDispose(() => {
              if (resolved.get(kind) === panel) resolved.delete(kind)
              changed.dispose()
            })
            follow()
          },
        },
        { webviewOptions: { retainContextWhenHidden: hidden !== 'destroyed' } },
      ),
    )
  }
  return subscriptions
}
