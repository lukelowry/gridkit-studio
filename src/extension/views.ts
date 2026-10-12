import { randomBytes, randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import type { Block } from '@latkit/model'
import * as vscode from 'vscode'

import { errorOf } from '../shared/errors.js'
import { commandId, followed, VIEW_COMMANDS, viewId } from '../shared/ids.js'
import type {
  FromView,
  Results,
  SentState,
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
 *  follows. Its page loads once, and follows another case by the state it is sent. What the page
 *  says names the case it is of, and what it says of a case the view no longer shows is dropped. */
class View {
  #answering!: Answerer
  /** The page loaded now: what a page before it asked is answered nothing more. */
  #page = 0
  readonly #videos = new VideoFiles()
  #uri?: string
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
    // failure, and say nothing: newer state follows.
    const report = (error: unknown) => studio.reporter.report(error)
    this.#report = report
    this.#answer()
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
        void this.send({
          kind: 'action',
          uri: action.uri,
          command: action.command,
          value: action.value,
        })
      }),
      ('onDidChangeViewState' in panel ? panel.onDidChangeViewState : panel.onDidChangeVisibility)(
        () => {
          if (hidden === 'idle') void this.send({ kind: 'shown', shown: panel.visible })
          if (panel.visible) {
            // The canvas the user brings to the front is the case the views follow.
            if ('active' in panel && panel.active && this.#uri && followed(this.#uri))
              studio.activate(this.#uri)
            void this.update().then(() => this.tick(), report)
          } else if (hidden === 'destroyed') {
            // The webview is destroyed, and what it asked with it; its replacement sends 'ready'.
            this.#ready = false
            this.#answer()
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

  /** Shows the case at `uri`, or none: its state, then its clock. What the page asked of the case
   *  before is the page's own to let go of, and is answered as asked. */
  follow(uri: string | undefined) {
    if (uri === this.#uri) return
    this.#uri = uri
    this.#shown = ''
    this.#summary = this.#settings = this.#outputs = undefined
    void this.update().catch(this.#report)
  }

  send(message: ToView): Thenable<boolean> {
    // A disposed view's late messages would reach a page that took its place.
    return this.#disposed ? Promise.resolve(false) : this.panel.webview.postMessage(packed(message))
  }

  /** Sends the view a snapshot of the clock of the case it shows. */
  tick() {
    const session = this.#uri ? this.studio.get(this.#uri) : undefined
    if (!session || !this.#ready || !this.panel.visible || !CLOCKED.has(this.kind)) return
    void this.send({
      kind: 'clock',
      uri: session.uri,
      clock: session.transport.snapshot(),
      live: session.transport.live,
      seq: this.#seq,
    })
  }

  /** Answers the page loaded now. A page before it is gone: what it asked is let go of, and its
   *  answers, which would reach the page that took its place, are never sent. */
  #answer() {
    this.#answering?.cancel()
    this.#unshare()
    const page = ++this.#page
    this.#answering = answerer(this.#handlers(), (reply) => {
      if (page === this.#page) void this.send(reply)
    })
  }

  async receive(message: FromView) {
    if (!message || typeof message !== 'object' || this.#disposed) return
    switch (message.kind) {
      case 'request':
      case 'cancel':
        return this.#answering.receive(message)
      case 'ready':
        // A page loading while one was loaded, as after a reload, replaces it: what that one
        // asked, worked on and wrote goes with it.
        if (this.#ready) {
          this.#answer()
          this.#work(undefined)
          this.#videos.dispose()
        }
        this.#ready = true
        this.#shown = ''
        this.#summary = this.#settings = this.#outputs = undefined
        // A page kept while hidden starts as though shown.
        if (this.hidden === 'idle') void this.send({ kind: 'shown', shown: this.panel.visible })
        return this.update()
      case 'error': {
        const { problem, context } = message
        this.studio.reporter.report(
          Object.assign(errorOf(problem), {
            detail: `[${this.kind}] ${problem.code} ${JSON.stringify(context ?? {})}\n${problem.detail ?? problem.message}`,
          }),
        )
        return
      }
      default:
        return this.#hear(message)
    }
  }

  /** What the page says of the case it shows; of a case the view no longer shows, nothing. */
  async #hear(message: Extract<FromView, { uri: string | undefined }>) {
    if (message.uri !== this.#uri) return
    const session = message.uri ? this.studio.get(message.uri) : undefined
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
        return this.#work(message.busy === true ? message.uri : undefined)
      case 'command':
        if (VIEW_COMMANDS.includes(message.command) && message.uri) {
          this.studio.activate(message.uri)
          await vscode.commands.executeCommand(commandId(message.command), message.value, {
            uri: message.uri,
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
      if (!this.#disposed) this.onIdle?.()
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
          : client.cases.call('rows', input, signal),
      presentation: (input, signal) =>
        'results' in input
          ? client.results.call('presentation', input, signal)
          : client.cases.call('presentation', input, signal),
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
      share: async ({ results }) => {
        const id = randomUUID()
        this.#shares.add(id)
        try {
          return await client.results.call('share', { results, as: id })
        } catch (error) {
          this.#shares.delete(id)
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
   *  hears a clock only of the case its last state named, so one sent before that state is lost.
   *  The Monitor and an export draw the case their results were read against, which waits for the
   *  session to have it. */
  async #once() {
    // A hidden view catches up when it shows; one kept working works on while hidden.
    if (!this.#ready || (!this.panel.visible && !(this.hidden === 'working' && this.busy))) return
    const session = this.#uri ? this.studio.get(this.#uri) : undefined
    const state: ViewState = this.#uri ? this.studio.state(this.#uri) : {}
    if ((this.kind === 'monitor' || this.kind === 'export') && state.results?.frames) {
      const described = session?.described
      if (!described) return
      state.summary = described
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
      await this.send({ kind: 'state', state: sent })
      this.tick()
    }
  }

  dispose() {
    this.#disposed = true
    this.onIdle = undefined
    this.#videos.dispose()
    this.#unshare()
    this.#answering.cancel()
    this.#work(undefined)
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
