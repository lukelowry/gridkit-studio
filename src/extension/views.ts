import * as vscode from 'vscode'

import { nonce as makeNonce, randomUUID } from '../platform/crypto.js'
import { basename } from '../platform/path.js'
import { nameOf } from '../platform/path.js'
import { shownType } from '../shared/cells.js'
import { isRange } from '../shared/data.js'
import { isEntity, sameField, tableLabel } from '../shared/document.js'
import { errorOf, problemOf, superseded } from '../shared/errors.js'
import { commandId, isCaseFile, viewId } from '../shared/ids.js'
import {
  type ExportStatus,
  framingOf,
  type FromView,
  type Of,
  type TableState,
  type ToView,
  type ViewApi,
  type ViewKind,
  type ViewMessage,
  type ViewState,
} from '../shared/messages.js'
import { isField, monitorWith } from '../shared/monitors.js'
import { type Answerer, answerer, type Handlers } from '../shared/rpc.js'
import { type DisplaySettings, isExportKey, validateSettings } from '../shared/settings.js'
import { changes } from '../shared/state.js'
import { ExportFiles } from './exports.js'
import { packed } from './packed.js'
import { setDisplay } from './settings.js'
import type { Studio } from './studio.js'

/** The views driven by a clock, including an export, which plays at its own speed. */
const CLOCKED: ReadonlySet<ViewKind> = new Set(['network', 'monitor', 'export'])
const PANELS = ['case', 'monitor', 'export'] as const
/** The settings each view may change: the Network's title bar buttons and the Export view's form. */
const CHANGES: Partial<Record<ViewKind, (key: string) => boolean>> = {
  network: (key) => ['network.projection', 'network.tilt', 'network.orbit'].includes(key),
  export: isExportKey,
}

/** A panel's description: the case name, then the panel's own details. */
function describe(studio: Studio, kind: ViewKind, uri: string): string {
  const { summary, table, results } = studio.state(uri)
  const parts = [summary?.name ?? nameOf(uri)]
  const type = summary && shownType(summary, table)
  if (kind === 'case' && summary && type) {
    parts.push(tableLabel(summary.definition, type))
    const count = summary.counts[type]
    const filtered = studio.get(uri)?.rows
    if ((table?.filter || table?.equal) && count !== undefined && filtered !== undefined)
      parts.push(`${filtered.toLocaleString()} of ${count.toLocaleString()}`)
  }
  // Never a run's outcome or progress: those belong to its notification.
  if (kind === 'monitor' && results) {
    if (results.solver) parts.push(basename(results.solver))
    if (results.frames) parts.push(`${results.frames.toLocaleString()} samples`)
  }
  return parts.join(', ')
}

/** Validates a Case panel table change; a part set to an invalid value is cleared. */
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

type Hidden = 'destroyed' | 'idle' | 'working'

function html(webview: vscode.Webview, context: vscode.ExtensionContext, kind: ViewKind) {
  const nonce = makeNonce()
  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  const asset = (path: string) =>
    escape(webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, path)).toString())
  // latkit's assets lie beside the page's bundles. It fetches its worker through the page and
  // starts it from a blob; map tiles come from the configured tiles URL.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource} https:;">
<meta name="latkit-assets" content="${asset('dist/webview/')}">
<link rel="stylesheet" href="${asset('dist/webview/' + kind + '.css')}"></head>
<body data-kind="${kind}"><div id="app"></div><script type="module" nonce="${nonce}" src="${asset('dist/webview/' + kind + '.js')}"></script></body></html>`
}

/** One webview and the case it shows: a Network editor's own case, or the active case for a panel.
 *  The page loads once and switches cases by the state it is sent. Each case shown and each page
 *  load starts a new generation; messages from either side for an older generation are dropped. */
class View {
  #answering!: Answerer
  readonly #exports = new ExportFiles()
  #of: Of
  /** The state last sent to the page; parts are compared by identity. */
  #sent: ViewState = {}
  /** Whether this generation's first state was sent; it tells the page its generation. */
  #stated = false
  /** Results the page shared for its own use, as an export does while reading them. */
  readonly #shares = new Set<string>()
  #ready = false
  #disposed = false
  #updateDue = false
  #updating?: Promise<void>
  /** The page's latest clock change in this generation, counted from zero as the page counts. */
  #seq = 0
  /** The case the view keeps while busy (an export), until done. */
  #working?: string
  /** The export's notification: how far it reported, and how to end it. */
  #progress?: { reported: number; end: () => void; report: (status: ExportStatus) => void }
  readonly #idle: () => void
  readonly #report: (error: unknown) => void
  readonly disposables: vscode.Disposable[] = []
  constructor(
    readonly studio: Studio,
    readonly panel: vscode.WebviewPanel | vscode.WebviewView,
    readonly kind: ViewKind,
    readonly hidden: Hidden,
    { uri, idle = () => {} }: { readonly uri?: string; readonly idle?: () => void } = {},
  ) {
    this.#of = { uri, generation: 0 }
    this.#idle = idle
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(studio.context.extensionUri, 'dist', 'webview')],
    }
    panel.webview.html = html(panel.webview, studio.context, kind)
    // Closed results and superseded revisions are quiet errors; newer state follows.
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
        // A title bar command acts on its own editor, not on another editor of the same case.
        if (action.active && !this.#active) return
        void this.send({ kind: 'action', of: this.#of, command: action.command })
      }),
      ('onDidChangeViewState' in panel ? panel.onDidChangeViewState : panel.onDidChangeVisibility)(
        () => {
          if (hidden === 'idle') void this.send({ kind: 'visible', visible: this.#visible })
          if (this.#visible) {
            // Bringing a canvas to the front makes its case the active case.
            const { uri } = this.#of
            if ('active' in panel && panel.active && uri && isCaseFile(uri)) studio.activate(uri)
            void this.update().then(() => this.tick(), report)
          } else if (hidden === 'destroyed') {
            // The webview and its requests are gone; the replacement sends 'ready'.
            this.#ready = false
            this.#startGeneration(this.#of.uri)
          }
        },
      ),
      panel.onDidDispose(() => this.dispose()),
    )
  }

  get uri(): string | undefined {
    return this.#of.uri
  }

  get busy(): boolean {
    return this.#working !== undefined
  }

  follow(uri: string | undefined) {
    if (uri === this.#of.uri) return
    this.#startGeneration(uri)
    void this.update().catch(this.#report)
  }

  /** Starts a new generation for `uri`: cancels the page's requests, resets the clock sequence and
   *  resends the full state. */
  #startGeneration(uri: string | undefined) {
    this.#of = { uri, generation: this.#of.generation + 1 }
    this.#seq = 0
    this.#sent = {}
    this.#stated = false
    this.#answer()
  }

  /** Whether the page is visible. False once disposed: VS Code throws on reading a disposed
   *  editor panel, and a view's work can outlast it. */
  get #visible(): boolean {
    return !this.#disposed && this.panel.visible
  }

  get #active(): boolean {
    return !this.#disposed && 'active' in this.panel && this.panel.active
  }

  send(message: ToView): Thenable<boolean> {
    // A disposed view's late messages would reach the page that replaced it.
    return this.#disposed ? Promise.resolve(false) : this.panel.webview.postMessage(packed(message))
  }

  tick() {
    const { uri } = this.#of
    const session = uri ? this.studio.get(uri) : undefined
    if (!session || !this.#ready || !this.#visible || !CLOCKED.has(this.kind)) return
    void this.send({
      kind: 'clock',
      of: this.#of,
      clock: session.transport.snapshot(),
      seq: this.#seq,
    })
  }

  /** Answers requests for the current generation. Requests from earlier generations are cancelled
   *  and their replies never sent. */
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
      // A page that reloads replaces the old one, along with its requests, work and exports.
      if (this.#ready) {
        this.#endExport()
        this.#work(undefined)
        this.#exports.dispose()
      }
      this.#ready = true
      this.#startGeneration(this.#of.uri)
      // A page kept while hidden starts as though shown.
      if (this.hidden === 'idle') void this.send({ kind: 'visible', visible: this.#visible })
      return this.update()
    }
    // Errors are reported from any generation.
    if (message.kind === 'error') {
      const { problem, context, of } = message
      this.studio.reporter.report(
        Object.assign(errorOf(problem), {
          detail: `[${this.kind}] ${problem.code} ${of?.uri ?? ''} ${JSON.stringify(context ?? {})}\n${problem.detail ?? problem.message}`,
        }),
      )
      return
    }
    if (message.of?.generation !== this.#of.generation) {
      // Reject a stale request quietly so the page releases it.
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
    return this.#handleMessage(message)
  }

  async #handleMessage(message: Extract<FromView, ViewMessage>) {
    const { uri } = this.#of
    const session = uri ? this.studio.get(uri) : undefined
    switch (message.kind) {
      case 'select':
        if (message.element === null || isEntity(message.element))
          session?.select(message.element ?? undefined)
        return
      case 'window': {
        const bounds = message.bounds
        if (this.kind !== 'monitor' || !session || !isRange(bounds)) return
        session.setWindow(bounds)
        return
      }
      case 'cycleMonitor':
        if (this.kind === 'monitor') session?.cycle(message.step === -1 ? -1 : 1)
        return
      case 'fitValues':
      case 'showMonitor':
      case 'splitMonitor':
      case 'unsplitMonitor': {
        if (this.kind !== 'monitor' || !session || !uri) return
        // Split from the keyboard asks which monitor, as Split Monitor does from the title bar.
        if (message.kind === 'splitMonitor' && message.monitor === undefined)
          return vscode.commands.executeCommand(commandId('splitMonitor'), vscode.Uri.parse(uri))
        if (!isField(message.monitor)) return
        const monitor = { table: message.monitor.table, field: message.monitor.field }
        if (message.kind === 'showMonitor') session.showMonitor(monitor)
        else if (message.kind === 'splitMonitor') session.split(monitor)
        else if (message.kind === 'unsplitMonitor') session.unsplit(monitor)
        else {
          const current = session.monitors.find((each) => sameField(each, monitor))
          if (current) session.setMonitor(monitorWith(current, current.id, undefined))
        }
        return
      }
      case 'open':
        if (!session || !uri || !isEntity(message.element)) return
        session.select(message.element)
        return this.studio.files.reveal(uri, message.element)
      case 'framing': {
        const framing = framingOf(message.framing)
        if (framing && this.kind === 'network') session?.setFraming(framing)
        return
      }
      case 'display': {
        const allowed = CHANGES[this.kind]
        if (!allowed || !uri) return
        const values = validateSettings(message.values)
        if (Object.keys(values).some((key) => !allowed(key))) return
        for (const key of Object.keys(values) as (keyof DisplaySettings)[])
          await setDisplay(vscode.Uri.parse(uri), key, values[key]!)
        return
      }
      case 'transport': {
        // Count it even if ignored, so clock snapshots acknowledge the page's latest change.
        if (Number.isSafeInteger(message.seq)) this.#seq = Math.max(this.#seq, message.seq)
        if (!session) return
        const { transport } = session
        if (message.action === 'seek') transport.seek(Number(message.value))
        else if (message.action === 'playPause') transport.playPause()
        else if (message.action === 'step') await session.step(message.value === -1 ? -1 : 1)
        return
      }
      case 'table':
        if (this.kind === 'case') session?.setTable(tableChange(message.change))
        return
      case 'rows':
        if (this.kind === 'case' && Number.isSafeInteger(message.total) && message.total >= 0)
          session?.setRows(message.total)
        return
      case 'export': {
        if (this.kind !== 'export') return
        const { status } = message
        if (status && typeof status.name === 'string' && status.total > 0) {
          this.#work(uri)
          this.#reportExport(status)
          return
        }
        this.#endExport()
        return this.#work(undefined)
      }
    }
  }

  /** Shows the export's progress in a notification, whose Cancel stops it, and in the view. */
  #reportExport(status: ExportStatus) {
    if (!this.#progress) {
      let end!: () => void
      const ended = new Promise<void>((resolve) => (end = resolve))
      const progress = (this.#progress = { reported: 0, end, report: (_: ExportStatus) => {} })
      const of = this.#of
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Exporting ' + status.name,
          cancellable: true,
        },
        (bar, token) => {
          token.onCancellationRequested(() => {
            if (of === this.#of) void this.send({ kind: 'action', of, command: 'cancelExport' })
          })
          progress.report = ({ done, total }) => {
            const percent = Math.min(100, (100 * done) / total)
            bar.report({
              increment: percent - progress.reported,
              message: Math.floor(percent) + '%',
            })
            progress.reported = percent
          }
          return ended
        },
      )
      void vscode.window.withProgress({ location: { viewId: viewId('export') } }, () => ended)
    }
    this.#progress.report(status)
  }

  #endExport() {
    this.#progress?.end()
    this.#progress = undefined
  }

  /** Holds the session of `uri` while the view works on it; `undefined` marks the work done. */
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

  /** The page's request handlers. A superseded revision is refused quietly. */
  #handlers(): Handlers<ViewApi> {
    const { studio } = this
    const { worker } = studio.client
    return {
      frames: (input, signal) => worker.call('frames', input, signal),
      tile: (input, signal) => worker.call('tile', input, signal),
      sample: (input, signal) => worker.call('sample', input, signal),
      caseRows: (input, signal) => worker.call('caseRows', input, signal),
      page: (input, signal) => {
        const read = worker.call('page', input, signal)
        if (this.kind === 'case')
          void vscode.window.withProgress({ location: { viewId: viewId('case') } }, () =>
            read.catch(() => {}),
          )
        return read
      },
      framing: async ({ uri }) => studio.get(uri)?.framing ?? null,
      exportOpen: ({ uri, name }, signal) =>
        this.#exports.open(vscode.Uri.parse(uri), name, signal),
      exportWrite: ({ file, bytes }) => this.#exports.write(file, bytes),
      exportClose: ({ file, abort }) => this.#exports.close(file, abort),
      exportSave: ({ uri, name, bytes }, signal) =>
        this.#exports.save(vscode.Uri.parse(uri), name, bytes, signal),
      // A share the page cancelled while it was being made is closed right away.
      share: async ({ results }, signal) => {
        const id = randomUUID()
        this.#shares.add(id)
        try {
          const shared = await worker.call('share', { results, as: id }, signal)
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

  #unshare() {
    for (const id of this.#shares) this.studio.closeResults(id)
    this.#shares.clear()
  }

  /** Brings the page up to date. A failed update leaves the next one due. */
  update(): Promise<void> {
    this.#updateDue = true
    return (this.#updating ??= (async () => {
      try {
        while (this.#updateDue && !this.#disposed) {
          this.#updateDue = false
          try {
            await this.#updateOnce()
          } catch (error) {
            this.#report(error)
          }
        }
      } finally {
        this.#updating = undefined
      }
    })())
  }

  /** Sends the changed state, then the clock (the page ignores a clock until its state names the
   *  generation). The Monitor and an export draw the case their results were read against; until
   *  it is known they keep what they draw, or get the results only once it is. */
  async #updateOnce() {
    // A hidden view catches up when shown; a working view keeps working while hidden.
    if (!this.#ready || (!this.#visible && !(this.hidden === 'working' && this.busy))) return
    const { uri } = this.#of
    const session = uri ? this.studio.get(uri) : undefined
    const state: ViewState = uri ? this.studio.state(uri) : {}
    if ((this.kind === 'monitor' || this.kind === 'export') && state.results?.frames) {
      const described = session?.described
      if (described) state.summary = described
      else if (this.#stated) {
        state.summary = this.#sent.summary
        state.results = this.#sent.results
      } else delete state.results
    }
    const changed = changes(this.kind, state, this.#sent)
    if (this.#stated && !changed) return
    // Only a delivered state counts as sent; a new generation started meanwhile gets everything.
    const of = this.#of
    if (!(await this.send({ kind: 'state', of, changed: changed ?? {} })) || of !== this.#of) return
    this.#sent = state
    this.#stated = true
    this.tick()
  }

  dispose() {
    this.#disposed = true
    this.#endExport()
    this.#exports.dispose()
    this.#unshare()
    this.#answering.cancel()
    this.#work(undefined)
    for (const disposable of this.disposables) disposable.dispose()
  }
}

export function registerViews(studio: Studio) {
  const network: vscode.CustomReadonlyEditorProvider = {
    // One document per file holds the case's session while any editor is open. The case becomes
    // active when an editor comes to the front, not on load, or the last of several would win.
    openCustomDocument(uri) {
      const key = uri.toString()
      if (!isCaseFile(key)) throw new Error('GridKit Studio shows saved .case.json files.')
      studio.hold(key, 'document')
      return { uri, dispose: () => studio.release(key, 'document') }
    },
    resolveCustomEditor(document, panel) {
      // The Network keeps its webview while hidden, so showing it again is free.
      new View(studio, panel, 'network', 'idle', { uri: document.uri.toString() })
    },
  }
  const subscriptions: vscode.Disposable[] = [
    vscode.window.registerCustomEditorProvider(viewId('network'), network, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
  ]
  for (const kind of PANELS) {
    // An export keeps working while its panel is collapsed. The Case panel replaces the Monitor in
    // the bottom panel, so the Monitor is kept idle rather than destroyed.
    const hidden = kind === 'export' ? 'working' : kind === 'monitor' ? 'idle' : 'destroyed'
    subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        viewId(kind),
        {
          resolveWebviewView(panel) {
            studio.panels.set(kind, panel)
            // Register disposal first, so a panel whose View fails to construct is not kept.
            let disposed = false
            let changed: vscode.Disposable | undefined
            panel.onDidDispose(() => {
              disposed = true
              if (studio.panels.get(kind) === panel) studio.panels.delete(kind)
              changed?.dispose()
            })
            /** Follows the active case unless busy. Writing to a disposed panel throws. */
            const follow = () => {
              if (disposed) return
              if (!view.busy) view.follow(studio.active)
              panel.description = view.uri && describe(studio, kind, view.uri)
            }
            const view = new View(studio, panel, kind, hidden, { idle: follow })
            changed = studio.changed.event((uri) => {
              if (uri === view.uri || uri === studio.active) follow()
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
