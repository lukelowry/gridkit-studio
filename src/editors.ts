import { randomBytes } from 'node:crypto'

import { type DataBatch, type RowsQuery, staticFields, type Value } from '@latkit/model'
import * as vscode from 'vscode'

import type { EditorKind, FromView, Summary, ToView } from './messages.js'
import type { Sessions } from './sessions.js'

export function html(
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
  #summary?: Summary
  #ready = false
  #stream = 0
  #controller?: AbortController
  #ack?: { stream: number; sequence: number; resolve(): void; reject(error: Error): void }
  #signature = ''
  #busy = false
  #queued = false
  #window?: readonly [number, number]
  #disposed = false
  #baseFingerprint?: string
  #sampleWindow?: readonly [number, number]
  readonly disposables: vscode.Disposable[] = []
  constructor(
    readonly studio: Sessions,
    readonly panel: vscode.WebviewPanel,
    readonly uri: string,
    readonly kind: EditorKind | 'monitor',
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(studio.context.extensionUri, 'dist', 'webview')],
    }
    panel.webview.html = html(
      panel.webview,
      studio.context,
      kind === 'table' ? 'table' : kind === 'monitor' ? 'monitor' : 'canvas',
      kind,
    )
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: FromView) => {
        void this.receive(message).catch((error) => studio.output.error(String(error)))
      }),
      studio.changed.event((changed) => {
        if (changed === uri) void this.update().catch((error) => studio.output.error(String(error)))
      }),
      studio.action.event((action) => {
        if (action.uri === uri) {
          if (action.command === 'monitorWindow' && typeof action.value === 'string') {
            const range = action.value.split(/[, ]+/).map(Number)
            if (range.length === 2 && range.every(Number.isFinite) && range[0]! < range[1]!) {
              this.#window = [range[0]!, range[1]!]
              this.#signature = ''
              void this.update()
            }
          }
          void this.send({ kind: 'action', command: action.command, value: action.value })
        }
      }),
      panel.onDidChangeViewState(() => {
        if (!panel.visible) this.cancel()
        else {
          if (panel.active) studio.activate(uri)
          this.#signature = ''
          void this.update().catch((error) => studio.output.error(String(error)))
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    )
  }
  send(message: ToView) {
    return this.panel.webview.postMessage(message)
  }
  cancel() {
    this.#controller?.abort()
    this.#ack?.reject(new Error('View hidden or replaced'))
    this.#ack = undefined
  }
  async receive(message: FromView) {
    if (!message || typeof message !== 'object') return
    if (message.kind === 'ready') {
      this.#ready = true
      this.#signature = ''
      this.#baseFingerprint = undefined
      this.#summary = undefined
      await this.update()
      return
    }
    if (message.kind === 'ack') {
      if (this.#ack?.stream === message.stream && this.#ack.sequence === message.sequence)
        this.#ack.resolve()
      return
    }
    if (message.kind === 'select') {
      if (typeof message.element?.id === 'string') this.studio.select(this.uri, message.element)
      return
    }
    if (message.kind === 'overlap') {
      this.studio.all.get(this.uri)!.overlaps = message.elements.slice(0, 100)
      return
    }
    if (message.kind === 'window' && this.kind === 'monitor') {
      const bounds = message.bounds
      if (
        bounds.length === 2 &&
        bounds.every(Number.isFinite) &&
        bounds[0] < bounds[1] &&
        JSON.stringify(bounds) !== JSON.stringify(this.#window)
      ) {
        this.#window = bounds
        await this.update()
      }
      return
    }
    if (message.kind === 'error') {
      this.studio.output.error(message.message)
      return
    }
    if (message.kind === 'command') {
      const allowed = [
        'runSolver',
        'stopSolver',
        'fit',
        'elementSource',
        'openTable',
        'openDiagram',
        'openMonitor',
        'chooseConfiguration',
        'previousSample',
        'nextSample',
        'seekTime',
        'followTime',
        'unfollowTime',
        'loopTime',
        'pauseTimeline',
        'toggleTimeline',
        'monitorWindow',
        'editField',
        'chooseColumns',
        'exportCsv',
        'clearTableFilter',
      ]
      if (allowed.includes(message.command)) {
        this.studio.activate(this.uri)
        await vscode.commands.executeCommand('gridkitStudio.' + message.command, message.value)
      }
      return
    }
    if (message.kind === 'request') {
      try {
        const entry = this.studio.documents.entries.get(this.uri)
        const summary = entry?.summary
        if (!summary || entry?.stale)
          throw new Error('The view is stale. Fix the case document first.')
        let value: unknown
        if (message.method === 'query') {
          const query = message.input as RowsQuery
          if (query?.kind !== 'rows' || !Number.isSafeInteger(query.limit) || query.limit! > 100)
            throw new Error('Invalid row query')
          value = await this.studio.client.call('query', {
            uri: this.uri,
            version: summary.version,
            query,
          })
        } else {
          const edit = message.input as { id: string; field: string; value: Value; version: number }
          await this.studio.documents.edit(this.uri, edit.version, edit, edit.value)
        }
        await this.send({ kind: 'reply', id: message.id, value })
      } catch (error) {
        await this.send({ kind: 'reply', id: message.id, error: String(error) })
      }
    }
  }
  async update() {
    if (this.#disposed || !this.#ready || !this.panel.visible) return
    const state = this.studio.state(this.uri)
    const sent = { ...state }
    if (state.summary === this.#summary) delete sent.summary
    else this.#summary = state.summary
    await this.send({ kind: 'state', state: sent })
    if (!state.summary || (state.stale && this.kind !== 'monitor') || this.kind === 'table') return
    if (this.#busy) {
      this.#queued = true
      return
    }
    const summary = state.summary
    const session = this.studio.all.get(this.uri)!
    const run =
      this.kind === 'monitor' || state.run?.fingerprint === summary.fingerprint
        ? state.run
        : undefined
    const baseFingerprint = this.kind === 'monitor' && run ? run.fingerprint : summary.fingerprint
    const at = state.at ?? run?.domain[1] ?? 0
    if (
      this.kind !== 'monitor' &&
      (!this.#sampleWindow || at < this.#sampleWindow[0] || at > this.#sampleWindow[1])
    )
      this.#sampleWindow = [at - 0.5, at + 0.5]
    const hasBindings = Object.keys(session.bindings).length > 0
    const sampledRun = this.kind === 'monitor' || hasBindings ? run : undefined
    const signature = [
      baseFingerprint,
      sampledRun?.id,
      sampledRun?.frames,
      JSON.stringify(session.plots),
      JSON.stringify(session.bindings),
      JSON.stringify(this.kind === 'monitor' ? this.#window : this.#sampleWindow),
    ].join(':')
    if (signature === this.#signature) return
    this.#signature = signature
    this.cancel()
    this.#busy = true
    const controller = (this.#controller = new AbortController())
    const stream = ++this.#stream
    try {
      const base = this.#baseFingerprint !== baseFingerprint
      if (this.kind === 'monitor' && run) {
        const width = this.#window
          ? this.#window[1] - this.#window[0]
          : Math.min(10, Math.max(1, run.domain[1] - run.domain[0]))
        if (!this.#window || state.follow)
          this.#window = [
            Math.max(run.domain[0], run.domain[1] - width),
            Math.max(run.domain[0] + width, run.domain[1]),
          ]
      }
      await this.send({
        kind: 'begin',
        stream,
        schema: summary.schema,
        revision: summary,
        base,
        window: this.#window,
      })
      let sequence = 0
      const consume = async (batches: readonly DataBatch[]) => {
        controller.signal.throwIfAborted()
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.#ack = undefined
            reject(new Error('View consumption timed out'))
          }, 10000)
          const done = () => {
            clearTimeout(timer)
            this.#ack = undefined
            resolve()
          }
          this.#ack = {
            stream,
            sequence: ++sequence,
            resolve: done,
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
      const fields = staticFields(summary.schema)
        .map((f) => ({
          ...f,
          select: f.select.filter((name) => {
            const def = summary.schema.types[f.from]!.fields[name]!
            return (
              name === 'name' ||
              name === summary.schema.types[f.from]!.spatial?.field ||
              (typeof def.type === 'object' && def.type.kind === 'reference')
            )
          }),
        }))
        .filter((f) => f.select.length > 0)
      if (this.kind === 'monitor' && run) {
        const signals = new Map<
          string,
          { from: string; select: string[]; rows?: { kind: 'ids'; ids: string[] } }
        >()
        for (const plot of session.plots) {
          const key = plot.from + '.' + plot.field
          const existing = signals.get(key)
          if (existing) {
            if (!plot.id) delete existing.rows
            else if (existing.rows && !existing.rows.ids.includes(plot.id))
              existing.rows.ids.push(plot.id)
          } else
            signals.set(key, {
              from: plot.from,
              select: [plot.field],
              ...(plot.id ? { rows: { kind: 'ids', ids: [plot.id] } } : {}),
            })
        }
        fields.push(...signals.values())
      }
      if (this.kind !== 'monitor' && sampledRun)
        fields.push(
          ...Object.entries(session.bindings).map(([from, field]) => ({ from, select: [field] })),
        )
      await this.studio.client.call(
        'batches',
        {
          uri: this.uri,
          version: summary.version,
          fields,
          includeStatic: base,
          ...(sampledRun
            ? {
                run: sampledRun.id,
                window: this.kind === 'monitor' ? this.#window : this.#sampleWindow,
              }
            : {}),
        },
        controller.signal,
        consume,
      )
      await this.send({ kind: 'end', stream })
      this.#baseFingerprint = baseFingerprint
    } catch (error) {
      if (!controller.signal.aborted) {
        this.#signature = ''
        this.studio.output.error(String(error))
        await this.send({ kind: 'action', command: 'error', value: String(error) })
      }
    } finally {
      this.#busy = false
      if (this.#queued && !this.#disposed) {
        this.#queued = false
        setTimeout(() => {
          void this.update().catch((error) => this.studio.output.error(String(error)))
        }, 150)
      }
    }
  }
  dispose() {
    this.#disposed = true
    this.cancel()
    for (const disposable of this.disposables) disposable.dispose()
  }
}
export function registerEditors(studio: Sessions) {
  const subscriptions: vscode.Disposable[] = []
  for (const kind of ['network', 'diagram', 'table'] as const)
    subscriptions.push(
      vscode.window.registerCustomEditorProvider(
        kind === 'table' ? 'gridkitStudio.tableEditor' : 'gridkitStudio.' + kind,
        {
          async resolveCustomTextEditor(document, panel) {
            new View(studio, panel, document.uri.toString(), kind)
            try {
              await studio.open(document)
            } catch (error) {
              studio.output.error(String(error))
            }
          },
        },
        {
          supportsMultipleEditorsPerDocument: true,
          webviewOptions: { retainContextWhenHidden: false },
        },
      ),
    )
  return subscriptions
}
