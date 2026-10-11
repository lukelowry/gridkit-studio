import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { Block, Query } from '@latkit/model'
import * as vscode from 'vscode'

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
import type { Sessions } from './sessions.js'
import { VideoFiles } from './video.js'

/** The views a clock moves. */
const CLOCKED: ReadonlySet<ViewKind> = new Set(['network', 'monitor'])
/** The commands a webview may run. */
const COMMANDS: ReadonlySet<string> = new Set([
  'elementSource',
  'plot',
  'addPlot',
  'removePlot',
  'chooseSignals',
])
/** How many rows the Case panel's filters leave, by case. */
const shownRows = new Map<string, number>()

/** What a panel's title says after its name: the case, and what the panel shows of it. The Case
 *  panel's type and filtered count, and the Monitor's results, live here rather than in the
 *  panels. */
function describe(studio: Sessions, kind: ViewKind, uri: string): string {
  const { summary, table, results } = studio.state(uri)
  const parts = [summary?.name ?? vscode.Uri.parse(uri).path.split('/').at(-1)]
  if (kind === 'case' && summary && table?.type) {
    parts.push(typeName(summary.schema, table.type))
    const count = summary.counts[table.type]
    const shown = shownRows.get(uri)
    if ((table.filter || table.equal) && count !== undefined && shown !== undefined)
      parts.push(`${shown.toLocaleString()} of ${count.toLocaleString()}`)
  }
  // What a run left, never how it ended, which only a notification says. How far one has come is
  // its notification's to say.
  if (kind === 'monitor' && results) {
    if (results.solver) parts.push(basename(results.solver))
    const study = results.contingency
    if (study) parts.push(`bus ${study.buses[study.shown]}`)
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
  case: ({ version, stale, error, writable, selection, bindings, table }) => [
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
class View {
  readonly #answering: Answerer
  readonly #videos = new VideoFiles()
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
    this.#answering = answerer(this.#handlers(), (reply) => void this.send(reply))
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
            this.cancel()
          }
        },
      ),
      panel.onDidDispose(() => this.dispose()),
    )
  }
  send(message: ToView): Thenable<boolean> {
    // A replaced view's late messages would reach the page that took its place.
    return this.#disposed ? Promise.resolve(false) : this.panel.webview.postMessage(packed(message))
  }
  /** Send the view a snapshot of the clock. */
  tick() {
    const session = this.studio.all.get(this.uri)
    if (!session || !this.#ready || !this.panel.visible) return
    if (!CLOCKED.has(this.kind)) return
    void this.send({
      kind: 'clock',
      clock: session.transport.snapshot(),
      live: session.transport.live,
      seq: this.#seq,
    })
  }
  /** Let go of the view's requests under way. */
  cancel() {
    this.#answering.cancel()
  }
  async receive(message: FromView) {
    if (!message || typeof message !== 'object' || this.#disposed) return
    const session = this.studio.all.get(this.uri)
    switch (message.kind) {
      case 'request':
      case 'cancel':
        return this.#answering.receive(message)
      case 'ready':
        this.#ready = true
        this.#settle()
        this.#shown = ''
        this.#summary = this.#settings = undefined
        this.tick()
        await this.update()
        return
      case 'select':
        if (message.element === null || typeof message.element?.id === 'string')
          this.studio.select(this.uri, message.element ?? undefined)
        return
      case 'window': {
        const bounds = message.bounds
        if (this.kind !== 'monitor' || !session || bounds?.length !== 2) return
        if (!bounds.every(Number.isFinite) || !(bounds[0] < bounds[1])) return
        session.window = [bounds[0], bounds[1]]
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
        return
      case 'error':
        this.studio.report(
          Object.assign(new Error(String(message.message)), {
            code: message.code,
            detail: `[${this.kind}] ${message.code ?? 'operation-failed'} ${JSON.stringify(message.context ?? {})}\n${message.detail ?? message.message}`,
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
    }
  }
  /** What the view may ask: of the case it shows, the results it draws, and the videos it exports.
   *  It asks for what it lacks of the case and the results: the case's revision names what it asks
   *  of, and is refused once stale. */
  #handlers(): Handlers<ViewApi> {
    const { studio, uri } = this
    const { client } = studio
    /** The case as it reads now. A request made while the case is read again, as it is after each
     *  edit, waits for that reading. A case that no longer reads keeps the view on its last
     *  revision, which says so, and the request is let go: Problems says why. */
    const read = async () => {
      const entry = studio.documents.entries.get(uri)
      const summary =
        entry && (await studio.documents.ensure(entry.document).catch(() => undefined))
      if (!summary) throw new DOMException('The case does not read.', 'AbortError')
      return summary
    }
    /** Rows of the case, or, `at` a time, of the shown results. */
    const query = async (query: Query.Rows, signal: AbortSignal) => {
      if (query?.kind !== 'rows') throw new Error('Invalid row query')
      const results = query.at === undefined ? undefined : studio.all.get(uri)?.results?.id
      const blocks = results
        ? await client.results.call('query', { results, query }, signal)
        : await client.cases.call('query', { uri, version: (await read()).version, query }, signal)
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
          void vscode.window.withProgress({ location: { viewId: 'gridkitStudio.case' } }, () =>
            rows.catch(() => {}),
          )
        return rows
      },
      transact: async ({ version, mutations, label }) => {
        await read()
        return studio.documents.transact(uri, version, [...mutations], label)
      },
      cameras: async () => studio.all.get(uri)?.cameras ?? {},
      videoOpen: ({ name, format }, signal) =>
        this.#videos.open(vscode.Uri.parse(uri), name, format, signal),
      videoWrite: ({ file, position, bytes }) => this.#videos.write(file, position, bytes),
      videoClose: ({ file, abort }) => this.#videos.close(file, abort),
    }
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
    // A hidden view catches up when it shows; one kept working works on while hidden.
    if (!this.#ready || (!this.panel.visible && !(this.hidden === 'working' && this.busy))) return
    const state = this.studio.state(this.uri)
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
  /** Whether its page is still loading where VS Code keeps one, on screen or kept while hidden:
   *  replacing it now breaks VS Code's loader. */
  get loading(): boolean {
    return !this.#ready && (this.panel.visible || this.hidden !== 'destroyed')
  }
  /** Settles once its page has loaded, it is disposed, or a few seconds pass. */
  get loaded(): Promise<void> {
    return Promise.race([this.#loaded, delay(5000)])
  }
  dispose() {
    this.#settle()
    this.#disposed = true
    this.cancel()
    this.#videos.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }
}
/** A panel while no case is open. */
const EMPTY = '<!doctype html><html lang="en"><body></body></html>'
/** The side bar and panel views VS Code has shown, by kind. */
const resolved = new Map<ViewKind, vscode.WebviewView>()

/** Show view `kind` without taking focus from where the user is. One never shown yet can only be
 *  shown by focusing it. */
export async function showView(kind: 'case' | 'monitor' | 'export') {
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
  for (const kind of ['case', 'monitor', 'export'] as const) {
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
                  ((kind === 'monitor' || kind === 'export') && studio.all.get(uri)?.results))
              ) {
                content = new View(studio, panel, uri, kind, hidden)
                panel.description = describe(studio, kind, uri)
              } else {
                panel.webview.html = EMPTY
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
