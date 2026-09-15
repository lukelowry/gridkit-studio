import { elementAt, type ElementRef, itemOf } from '@latkit/model'
import { OPTIONS, type Projection, PROJECTIONS } from '@latkit/network'
import type { Port } from '@latkit/port'
import * as vscode from 'vscode'

import { showSource } from '../actions.js'
import { coalesce, Latest } from '../async.js'
import { DISPLAY_CHANNELS, type DisplayChannel } from '../bindings.js'
import type { Cases, CaseState } from '../case.js'
import { report } from '../commands.js'
import { bound, type Capabilities, classCapabilities, NO_CAPABILITIES } from '../menus.js'
import { html, webviewPort } from '../webview/host.js'
import { isRequest, type ToWebview } from './messages.js'
import { type DisplayOptions, optionLabel, validOptions } from './options.js'

export const NETWORK = 'gridkitStudio.network'
type Panel = {
  state: CaseState
  port: Port
  ready: boolean
  projection: Projection
  projections: Projection[]
  options: DisplayOptions
  reads: Latest
  channels: () => void
}
export class NetworkEditor implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly panels = new Map<vscode.WebviewPanel, Panel>()
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cases: Cases,
  ) {}
  get activeDocument(): vscode.TextDocument | undefined {
    return this.active()?.[1].state.document
  }
  private active(): [vscode.WebviewPanel, Panel] | undefined {
    return [...this.panels].find(([panel]) => panel.active)
  }
  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const state = this.cases.get(document)
    const view: Panel = {
      state,
      port: webviewPort(panel.webview),
      ready: false,
      projection: 'flat',
      projections: [...PROJECTIONS],
      options: {},
      reads: new Latest(),
      channels: coalesce(() => this.channels(panel, view)),
    }
    this.panels.set(panel, view)
    if (panel.active) this.cases.focus(state)
    const subscriptions = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gridkitStudio.branchColorsFromBuses', document.uri))
          this.settings(view)
      }),
      state.onDidChange((kind) => {
        if (kind === 'pending' || kind === 'draft') return
        if (kind === 'monitoring') this.post(view, { type: 'target', ...state.target })
        if (kind === 'snapshot') this.update(panel, view)
        else if (kind === 'time') view.channels()
        else if (kind === 'selection') void this.selection(panel, view)
        else if (kind !== 'setup') {
          view.channels()
          void this.menu(panel, view)
          void this.selection(panel, view)
        }
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.cases.focus(state)
        if (panel.visible && view.ready) this.update(panel, view)
      }),
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isRequest(message)) return
        try {
          if (message.type === 'ready') {
            view.ready = true
            this.cases.documents.read(document)
            this.settings(view)
            this.update(panel, view)
          } else if (message.type === 'focus') {
            this.cases.focus(state)
          } else if (message.type === 'source') {
            await this.source(state)
          } else if (state.current(message)) {
            if (message.type === 'select') {
              const ready = this.cases.resolve(message)
              const ref = message.item && ready ? elementAt(ready.fields.model, message.item) : null
              if (message.item && !ref) return
              await this.cases.select(message, ref ? { element: ref } : null)
            } else if (message.type === 'view') {
              view.projection = message.projection
              view.projections = message.projections
              view.options = message.options
            } else console.error(`GridKit network: ${message.message}`)
          }
        } catch (error) {
          report(error)
        }
      }),
    ]
    panel.onDidDispose(() => {
      view.reads.abort()
      this.panels.delete(panel)
      for (const off of subscriptions) off.dispose()
    })
    panel.webview.html = html(
      panel.webview,
      this.extensionUri,
      'network',
      `<main aria-label="Network">
<canvas id="network" tabindex="0" aria-label="Power system network"></canvas>
<div id="notice" role="status"><p id="message">Loading network...</p><button id="source" type="button">Open JSON</button><button id="retry" type="button" hidden>Retry</button></div>
</main><div id="context" hidden></div>`,
    )
  }
  private async source(state: CaseState): Promise<void> {
    if (state.snapshot.state === 'valid')
      await showSource(this.cases, { ...state.target, ...state.selection })
    else
      await vscode.window.showTextDocument(state.document, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      })
  }
  private settings(view: Panel): void {
    view.port.post({
      type: 'settings',
      branchColorsFromBuses: vscode.workspace
        .getConfiguration('gridkitStudio', view.state.document.uri)
        .get('branchColorsFromBuses', true),
    } satisfies ToWebview)
  }
  private post(view: Panel, message: ToWebview): void {
    view.port.post(message)
  }
  private update(panel: vscode.WebviewPanel, view: Panel): void {
    view.reads.abort()
    if (!view.ready || !panel.visible) return
    const { state } = view
    const { snapshot } = state
    if (snapshot.state === 'valid') {
      this.post(view, {
        type: 'scene',
        ...state.target,
        topology: snapshot.case.model.topology,
        owners: snapshot.case.model.owners,
      })
      void this.selection(panel, view)
      view.channels()
      void this.menu(panel, view)
    } else if (snapshot.state === 'pending') this.post(view, { type: 'pending', ...state.target })
    else this.post(view, { type: 'invalid', ...state.target, message: snapshot.issues[0].message })
  }
  private async selection(panel: vscode.WebviewPanel, view: Panel): Promise<void> {
    const { state } = view
    const { fields, selection } = state
    const target = state.target
    if (!view.ready || !panel.visible || !fields) return
    try {
      const field = selection?.field ? await fields.field(selection.field, state.signal) : undefined
      if (!state.current(target) || state.selection !== selection || !this.panels.has(panel)) return
      const capabilities = selection
        ? classCapabilities(
            fields.model,
            selection.element.classId,
            !field || !('kind' in field) || field.kind === 'number',
            state.bindings,
          )
        : { ...NO_CAPABILITIES }
      if (selection) {
        capabilities.plot =
          !!state.source &&
          fields
            .recorded(selection.element.classId)
            .some((field) => state.source!.has(field, selection.element.index))
        if (selection.field)
          capabilities.unbind = bound(state.bindings, selection.element.classId, selection.field)
      }
      this.post(view, {
        type: 'selection',
        ...target,
        selection,
        capabilities,
        navigate: vscode.workspace
          .getConfiguration('gridkitStudio')
          .get('navigateOnSelection', true),
        item: selection ? itemOf(fields.model, selection.element) : null,
      })
    } catch {
      /* The field or snapshot was replaced. */
    }
  }
  private async menu(panel: vscode.WebviewPanel, view: Panel): Promise<void> {
    const { state } = view
    const { fields, bindings } = state
    const target = state.target
    if (!view.ready || !fields) return
    const capabilities: Partial<Record<'vertex' | 'edge', Capabilities>> = {}
    try {
      await Promise.all(
        (['vertex', 'edge'] as const).map(async (kind) => {
          const classId = fields.model.owners[kind]
          if (!classId) return
          const list = await fields.list(classId, state.signal)
          capabilities[kind] = {
            ...classCapabilities(fields.model, classId, list.length > 0, bindings),
            plot: fields.signals(classId).length > 0,
          }
        }),
      )
      if (state.current(target) && state.bindings === bindings && this.panels.has(panel))
        this.post(view, { type: 'context', ...target, capabilities })
    } catch {
      /* Snapshot changed during the field read. */
    }
  }
  private async channels(panel: vscode.WebviewPanel, view: Panel): Promise<void> {
    const signal = view.reads.next()
    const { state } = view
    const { fields, bindings } = state
    const target = state.target
    if (!view.ready || !panel.visible || !fields) return
    try {
      const values: Partial<Record<DisplayChannel, Float32Array>> = {}
      const { time, frame } = state.timeline
      await Promise.all(
        DISPLAY_CHANNELS.map(async (channel) => {
          const binding = bindings[channel]
          if (!binding) return
          if (binding.field.source === 'signal' && !state.source?.has(binding.field)) return
          const color = channel === 'vertexColor' || channel === 'edgeColor'
          const range =
            color || (binding.field.source === 'signal' && !binding.range)
              ? await state.signalRange(binding.field, signal)
              : binding.range
          values[channel] = await fields.values(channel, { ...binding, range }, signal, time, frame)
        }),
      )
      if (!signal.aborted && state.current(target) && bindings === state.bindings)
        this.post(view, { type: 'channels', ...target, values, colormap: state.display.colormap })
    } catch (error) {
      if (!signal.aborted && state.current(target)) console.warn('Cannot display signals:', error)
    }
  }
  async show(state: CaseState): Promise<void> {
    const existing =
      [...this.panels].find(([panel, view]) => view.state === state && panel.visible) ??
      [...this.panels].find(([, view]) => view.state === state)
    if (existing) {
      existing[0].reveal(existing[0].viewColumn)
      void this.selection(...existing)
    } else
      await vscode.commands.executeCommand('vscode.openWith', state.document.uri, NETWORK, {
        viewColumn: vscode.ViewColumn.Active,
        preview: false,
      })
  }
  fit(): void {
    const active = this.active()
    if (active) this.post(active[1], { type: 'fit' })
  }
  orbit(): void {
    const active = this.active()
    if (active) this.post(active[1], { type: 'orbit' })
  }
  reveal(state: CaseState, element: ElementRef, neighbors: boolean): void {
    const item = state.fields && itemOf(state.fields.model, element)
    if (!item) return
    for (const [panel, view] of this.panels)
      if (view.state === state && panel.visible)
        this.post(view, { type: 'reveal', ...state.target, item, neighbors })
  }
  async projection(): Promise<void> {
    const active = this.active()
    if (!active) return
    const [panel, view] = active
    const target = view.state.target
    const choice = await vscode.window.showQuickPick(
      view.projections.map((projection) => ({
        label: optionLabel(projection),
        projection,
        description: projection === view.projection ? 'Current' : undefined,
      })),
      { title: 'Network projection' },
    )
    if (choice && this.panels.has(panel) && view.state.current(target))
      this.post(view, { type: 'projection', projection: choice.projection })
  }
  async options(): Promise<void> {
    const active = this.active()
    if (!active) return
    const [panel, view] = active
    const target = view.state.target
    const entries = Object.entries(OPTIONS)
      .filter(([key, definition]) => definition.live && key !== 'colormap')
      .map(([key]) => ({ label: optionLabel(key), key }))
    entries.push({ label: 'Case colormap', key: 'sharedColormap' })
    entries.push({ label: 'Pointer spotlight', key: 'shade' })
    const choice = await vscode.window.showQuickPick(entries, { title: 'Network display options' })
    if (!choice || !view.state.current(target) || !this.panels.has(panel)) return
    const key = choice.key
    if (key === 'sharedColormap') {
      await vscode.commands.executeCommand('gridkitStudio.signalColormap', target)
      return
    }
    const definition = OPTIONS[key as keyof typeof OPTIONS]
    let value: unknown
    if (key === 'shade') {
      value = (
        await vscode.window.showQuickPick(
          [
            { label: 'Off', value: 'none' },
            { label: 'On', value: 'spotlight' },
          ],
          { title: 'Pointer spotlight' },
        )
      )?.value
    } else if (definition.kind === 'boolean' || definition.kind === 'enum') {
      const choices = definition.kind === 'boolean' ? [true, false] : definition.values
      value = (
        await vscode.window.showQuickPick(
          choices.map((value) => ({ label: String(value), value })),
          { title: choice.label },
        )
      )?.value
    } else {
      const text = await vscode.window.showInputBox({
        title: choice.label,
        prompt:
          definition.kind === 'rgba'
            ? 'RGBA values from 0 to 1: [red, green, blue, alpha]'
            : definition.kind === 'domain'
              ? 'Output range: [minimum, maximum]'
              : definition.kind === 'insets'
                ? 'Pixels: one number or [top, right, bottom, left]'
                : 'Numeric value',
        value: JSON.stringify(view.options[key as keyof DisplayOptions] ?? definition.default),
        validateInput: (text) => {
          try {
            return validOptions({ [key]: JSON.parse(text) })
              ? undefined
              : 'This value is not supported.'
          } catch {
            return 'Enter a number, array, or null for automatic (where supported).'
          }
        },
      })
      if (text === undefined) return
      value = JSON.parse(text)
    }
    if (value === undefined || !view.state.current(target) || !this.panels.has(panel)) return
    const options = { [key]: value }
    if (validOptions(options)) this.post(view, { type: 'options', options })
  }
  async showSource(): Promise<void> {
    const state = this.active()?.[1].state ?? this.cases.active
    if (state && !state.document.isClosed) await this.source(state)
  }
  dispose(): void {
    for (const panel of [...this.panels.keys()]) panel.dispose()
  }
}
