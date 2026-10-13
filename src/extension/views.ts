import { randomBytes, randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import type { Block } from '@latkit/model'
import * as vscode from 'vscode'

import { shownType } from '../shared/cells.js'
import { errorOf, problemOf, superseded } from '../shared/errors.js'
import { commandId, followed, VIEW_COMMANDS, viewId } from '../shared/ids.js'
import type {
  FromView,
  Of,
  Results,
  SentState,
  Summary,
  TableState,
  ToView,
  ViewApi,
  ViewKind,
  ViewMessage,
  ViewState,
} from '../shared/messages.js'
import type { SettingsValues } from '../shared/preferences.js'
import { type Answerer, answerer, type Handlers } from '../shared/rpc.js'
import { typeName } from '../shared/schema.js'
import { drawnOf } from '../shared/simulation.js'
import { packed } from './packed.js'
import type { Sessions } from './sessions.js'
import { VideoFiles } from './video.js'

/** The views a clock moves, and an export, which plays at its speed. */
const CLOCKED: ReadonlySet<ViewKind> = new Set(['network', 'monitor', 'export'])
/** The views in VS Code's panels, which follow the case the views follow. */
const PANELS = ['case', 'monitor', 'export'] as const

/** What a panel's title says after its name: the case, and what the panel shows of it. The Case
 *  panel's type and filtered count, and the Monitor's results, live here rather than in the
 *  panels. */
function describe(studio: Sessions, kind: ViewKind, uri: string): string {
  const { summary, table, results } = studio.state(uri)
  const parts = [summary?.name ?? vscode.Uri.parse(uri).path.split('/').at(-1)]
  const type = summary && shownType(summary, table)
  if (kind === 'case' && summary && type) {
    parts.push(typeName(summary.schema, type))
    const count = summary.counts[type]
    const shown = studio.get(uri)?.rows
    if ((table?.filter || table?.equal) && count !== undefined && shown !== undefined)
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

/** What the Case panel says it changed of what it shows, each part of its own kind; a part said to
 *  be nothing goes. */
function tableChange(change: unknown): Partial<TableState> {
  const given = (change && typeof change === 'object' ? change : {}) as Record<string, unknown>
  const kept: Partial<TableState> = {}
  const text = (value: unknown): value is string => typeof value === 'string'
  if (text(given.type)) kept.type = given.type
  if ('filter' in given) kept.filter = text(given.filter) ? given.filter : undefined
  if ('equal' in given) {
    const equal = given.equal as TableState['equal']
    kept.equal =
      text(equal?.field) && ['string', 'number', 'boolean'].includes(typeof equal.value)
        ? { field: equal.field, value: equal.value }
        : undefined
  }
  if ('order' in given) {
    const order = given.order as TableState['order']
    kept.order =
      text(order?.field) && (order.direction === 'ascending' || order.direction === 'descending')
        ? { field: order.field, direction: order.direction }
        : undefined
  }
  return kept
}

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
    drawnOf(results),
  ],
  // Results the plots show have a fixed span while a run writes them, else the times they hold.
  monitor: ({ uri, stale, selection, bindings, plots, window, results }) => [
    uri,
    stale,
    selection,
    bindings,
    plots,
    window,
    drawnOf(results),
  ],
  // An export shows the times the Monitor shows.
  export: ({ uri, stale, error, bindings, plots, window, results }) => [
    uri,
    stale,
    error,
    bindings,
    plots,
    window,
    drawnOf(results),
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
 *  follows. Its page loads once, and follows another case by the state it is sent. Each case it
 *  follows, and each page that loads, is a showing of its own: what the page says and asks names
 *  its showing, and what it says of one past is dropped, as the page drops what is said to it of
 *  one past. */
class View {
  #answering!: Answerer
  readonly #videos = new VideoFiles()
  /** The showing of the case the view shows. */
  #of: Of
  #summary?: Summary
  #settings?: SettingsValues
  /** The results' outputs last sent, which a state of the same results leaves out. */
  #outputs?: Results['outputs']
  /** The results the page holds of its own, as an export does while it reads them. */
  readonly #shares = new Set<string>()
  #shown = ''
  #ready = false
  #disposed = false
  /** Whether another update is due, and the update in progress. */
  #again = false
  #running?: Promise<void>
  /** The latest change this showing made to the clock, counted from naught as the page counts it. */
  #seq = 0
  /** The case the view works on while it is mid-task, as an export is, which it keeps till done. */
  #working?: string
  /** Hears once the view is done with its task. */
  readonly #idle: () => void
  readonly #report: (error: unknown) => void
  readonly disposables: vscode.Disposable[] = []
  /** A view of `kind` in `panel`, showing the case at `uri`, which hears once it is done with a
   *  task by `idle`. */
  constructor(
    readonly studio: Sessions,
    readonly panel: vscode.WebviewPanel | vscode.WebviewView,
    readonly kind: ViewKind,
    readonly hidden: Hidden,
    { uri, idle = () => {} }: { readonly uri?: string; readonly idle?: () => void } = {},
  ) {
    this.#of = { uri, showing: 0 }
    this.#idle = idle
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
    // failure, and say nothing: newer state follows.
    const report = (error: unknown) => studio.reporter.report(error)
    this.#report = report
    this.#answer()
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: FromView) => {
        void this.receive(message).catch(report)
      }),
      studio.changed.event((changed) => {
        if (changed === this.#of.uri) void this.update().catch(report)
      }),
      studio.clock.event((changed) => {
        if (changed === this.#of.uri) this.tick()
      }),
      studio.action.event((action) => {
        if (action.uri !== this.#of.uri || (action.view && action.view !== kind)) return
        void this.send({
          kind: 'action',
          of: this.#of,
          command: action.command,
          value: action.value,
        })
      }),
      ('onDidChangeViewState' in panel ? panel.onDidChangeViewState : panel.onDidChangeVisibility)(
        () => {
          if (hidden === 'idle') void this.send({ kind: 'shown', shown: panel.visible })
          if (panel.visible) {
            // The canvas the user brings to the front is the case the views follow.
            const { uri } = this.#of
            if ('active' in panel && panel.active && uri && followed(uri)) studio.activate(uri)
            void this.update().then(() => this.tick(), report)
          } else if (hidden === 'destroyed') {
            // The webview is destroyed, and what it asked with it; its replacement sends 'ready'.
            this.#ready = false
            this.#show(this.#of.uri)
          }
        },
      ),
      panel.onDidDispose(() => this.dispose()),
    )
  }

  /** The case the view shows. */
  get uri(): string | undefined {
    return this.#of.uri
  }

  /** Whether the view is mid-task, and must keep the case it works on. */
  get busy(): boolean {
    return this.#working !== undefined
  }

  /** Shows the case at `uri`, or none: its state, then its clock. */
  follow(uri: string | undefined) {
    if (uri === this.#of.uri) return
    this.#show(uri)
    void this.update().catch(this.#report)
  }

  /** Shows the case at `uri` anew: what the page asked and held before is let go of, its changes to
   *  the clock count from naught, and it is sent all it shows again. */
  #show(uri: string | undefined) {
    this.#of = { uri, showing: this.#of.showing + 1 }
    this.#seq = 0
    this.#shown = ''
    this.#summary = this.#settings = this.#outputs = undefined
    this.#answer()
  }

  send(message: ToView): Thenable<boolean> {
    // A disposed view's late messages would reach a page that took its place.
    return this.#disposed ? Promise.resolve(false) : this.panel.webview.postMessage(packed(message))
  }

  /** Sends the view a snapshot of the clock of the case it shows. */
  tick() {
    const { uri } = this.#of
    const session = uri ? this.studio.get(uri) : undefined
    if (!session || !this.#ready || !this.panel.visible || !CLOCKED.has(this.kind)) return
    void this.send({
      kind: 'clock',
      of: this.#of,
      clock: session.transport.snapshot(),
      live: session.live,
      seq: this.#seq,
    })
  }

  /** Answers the showing now. What a showing before asked is let go of, and its answers, which
   *  would reach a page that shows another, are never sent. */
  #answer() {
    this.#answering?.cancel()
    this.#unshare()
    const of = this.#of
    this.#answering = answerer(this.#handlers(), (reply) => {
      if (of === this.#of) void this.send({ ...reply, of })
    })
  }

  async receive(message: FromView) {
    if (!message || typeof message !== 'object' || this.#disposed) return
    if (message.kind === 'ready') {
      // A page loading while one was loaded, as after a reload, replaces it: what that one asked,
      // worked on and wrote goes with it. Either way the page loaded is a showing of its own.
      if (this.#ready) {
        this.#work(undefined)
        this.#videos.dispose()
      }
      this.#ready = true
      this.#show(this.#of.uri)
      // A page kept while hidden starts as though shown.
      if (this.hidden === 'idle') void this.send({ kind: 'shown', shown: this.panel.visible })
      return this.update()
    }
    // Why something failed is said whatever showing it is of.
    if (message.kind === 'error') {
      const { problem, context, of } = message
      this.studio.reporter.report(
        Object.assign(errorOf(problem), {
          detail: `[${this.kind}] ${problem.code} ${of?.uri ?? ''} ${JSON.stringify(context ?? {})}\n${problem.detail ?? problem.message}`,
        }),
      )
      return
    }
    if (message.of?.showing !== this.#of.showing) {
      // A request of a showing past is answered, quietly, so the page that asked lets go of it.
      if (message.kind === 'request')
        void this.send({
          kind: 'reply',
          id: message.id,
          problem: problemOf(superseded()),
          of: message.of,
        })
      return
    }
    if (message.kind === 'request' || message.kind === 'cancel')
      return this.#answering.receive(message)
    return this.#hear(message)
  }

  /** What the page says of the case it shows now. */
  async #hear(message: Extract<FromView, ViewMessage>) {
    const { uri } = this.#of
    const session = uri ? this.studio.get(uri) : undefined
    switch (message.kind) {
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
        // Counted whatever comes of it, so the clock's answers say the page's latest change.
        if (Number.isSafeInteger(message.seq)) this.#seq = Math.max(this.#seq, message.seq)
        if (!session) return
        const { transport } = session
        if (message.action === 'seek') transport.seek(Number(message.value))
        else if (message.action === 'rate') transport.setRate(Number(message.value))
        else if (message.action === 'playPause') transport.playPause()
        else if (message.action === 'goLive') transport.goLive()
        else if (message.action === 'step') await session.step(message.value === -1 ? -1 : 1)
        return
      }
      case 'table':
        if (this.kind === 'case') session?.setTable(tableChange(message.change))
        return
      case 'rows':
        if (this.kind === 'case' && Number.isSafeInteger(message.shown) && message.shown >= 0)
          session?.setRows(message.shown)
        return
      case 'busy':
        return this.#work(message.busy === true ? uri : undefined)
      case 'command':
        if (VIEW_COMMANDS.includes(message.command) && uri && followed(uri)) {
          this.studio.activate(uri)
          await vscode.commands.executeCommand(commandId(message.command), message.value, {
            uri,
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
      if (!this.#disposed) this.#idle()
    }
  }

  /** What the view may ask: of the revision of a case, or of results, each request naming which,
   *  and the videos it exports. A revision a newer one replaced is refused, quietly. */
  #handlers(): Handlers<ViewApi> {
    const { studio } = this
    const { client } = studio
    const rows = async (input: ViewApi['query']['input'], signal: AbortSignal) => {
      if (input.query?.kind !== 'rows') throw new Error('Invalid row query')
      const blocks =
        'results' in input
          ? await client.results.call('query', input, signal)
          : await client.cases.call('query', { ...input.revision, query: input.query }, signal)
      return blocks.filter((block): block is Block.Rows => block.kind === 'rows')
    }
    return {
      samples: (input, signal) => client.results.call('samples', input, signal),
      rows: (input, signal) =>
        'results' in input
          ? client.results.call('rows', input, signal)
          : client.cases.call('rows', { ...input.revision, fields: input.fields }, signal),
      presentation: (input, signal) =>
        'results' in input
          ? client.results.call('presentation', input, signal)
          : client.cases.call('presentation', input.revision, signal),
      query: (input, signal) => {
        const read = rows(input, signal)
        // The Case panel's rows load under VS Code's own progress bar on the view.
        if (this.kind === 'case')
          void vscode.window.withProgress({ location: { viewId: viewId('case') } }, () =>
            read.catch(() => {}),
          )
        return read
      },
      transact: ({ revision, mutations, label }) =>
        studio.documents.transact(
          revision.uri,
          revision.version,
          mutations,
          label,
          revision.attachmentId,
        ),
      cameras: async ({ uri }) => studio.get(uri)?.cameras ?? {},
      videoOpen: ({ uri, name, format }, signal) =>
        this.#videos.open(vscode.Uri.parse(uri), name, format, signal),
      videoWrite: ({ file, position, bytes }) => this.#videos.write(file, position, bytes),
      videoClose: ({ file, abort }) => this.#videos.close(file, abort),
      // A share the page let go of as it was made holds nothing past it.
      share: async ({ results }, signal) => {
        const id = randomUUID()
        this.#shares.add(id)
        try {
          const shared = await client.results.call('share', { results, as: id }, signal)
          signal.throwIfAborted()
          return shared
        } catch (error) {
          if (this.#shares.delete(id)) studio.closeResults(id)
          throw error
        }
      },
      unshare: async ({ results }) => {
        if (this.#shares.delete(results)) studio.closeResults(results)
        return null
      },
    }
  }

  /** Lets go of every results the page held of its own. */
  #unshare() {
    for (const id of this.#shares) this.studio.closeResults(id)
    this.#shares.clear()
  }

  /** Brings the view up to date; resolves once it is. An update that fails leaves the next due. */
  update(): Promise<void> {
    this.#again = true
    return (this.#running ??= (async () => {
      try {
        while (this.#again && !this.#disposed) {
          this.#again = false
          try {
            await this.#once()
          } catch (error) {
            this.#report(error)
          }
        }
      } finally {
        this.#running = undefined
      }
    })())
  }

  /** Sends the view its state, when what it shows of it changed, and the clock after it: a page
   *  hears a clock only of the showing its last state named, so one sent before that state is lost.
   *  The Monitor and an export draw the case their results were read against, once the session
   *  has it: a page that shows the case keeps what it draws till then, and one that follows it now
   *  is told at once of the case, and of the results once they are known. */
  async #once() {
    // A hidden view catches up when it shows; one kept working works on while hidden.
    if (!this.#ready || (!this.panel.visible && !(this.hidden === 'working' && this.busy))) return
    const { uri } = this.#of
    const session = uri ? this.studio.get(uri) : undefined
    const state: ViewState = uri ? this.studio.state(uri) : {}
    if ((this.kind === 'monitor' || this.kind === 'export') && state.results?.frames) {
      const described = session?.described
      if (described) state.summary = described
      else if (this.#shown) return
      else delete state.results
    }
    const signature = JSON.stringify(SHOWN[this.kind](state))
    if (
      signature !== this.#shown ||
      state.summary !== this.#summary ||
      state.settings !== this.#settings
    ) {
      // The summary, settings and results' outputs are large and change seldom; each is sent only
      // when it changed.
      const sent: SentState = { ...state }
      if (state.summary === this.#summary) delete sent.summary
      if (state.settings === this.#settings) delete sent.settings
      const { results } = state
      if (results && results.outputs === this.#outputs) {
        const { outputs: _, ...rest } = results
        sent.results = rest
      }
      this.#shown = signature
      this.#summary = state.summary
      this.#settings = state.settings
      this.#outputs = results?.outputs
      await this.send({ kind: 'state', of: this.#of, state: sent })
      this.tick()
    }
  }

  dispose() {
    this.#disposed = true
    this.#videos.dispose()
    this.#unshare()
    this.#answering.cancel()
    this.#work(undefined)
    for (const disposable of this.disposables) disposable.dispose()
  }
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
            new View(studio, panel, kind, 'idle', { uri: document.uri.toString() })
            // Read while the webview loads. The views follow the case once its editor is in front,
            // not as it loads: of editors loading side by side, the last would win.
            void studio.documents.parsed(document)
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
            studio.panels.set(kind, panel)
            /** The panel follows the case the views follow, unless it works on another. */
            const follow = () => {
              if (!view.busy) view.follow(studio.active)
              panel.description = view.uri && describe(studio, kind, view.uri)
            }
            const view = new View(studio, panel, kind, hidden, { idle: follow })
            // Only the case it shows, or the one it is to show, changes what it shows.
            const changed = studio.changed.event((uri) => {
              if (uri === view.uri || uri === studio.active) follow()
            })
            panel.onDidDispose(() => {
              if (studio.panels.get(kind) === panel) studio.panels.delete(kind)
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
