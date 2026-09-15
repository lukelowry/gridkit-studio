import type { Port, Service } from '@latkit/port'
import * as vscode from 'vscode'

import { Latest } from '../async.js'
import { channelsFor } from '../bindings.js'
import type { Cases, CaseState } from '../case.js'
import { describe } from '../errors.js'
import { bound, classCapabilities, NO_CAPABILITIES } from '../menus.js'
import { html, webviewPort } from '../webview/host.js'
import { tableColumns, tableFieldId } from './columns.js'
import { defaults, isRequest, isSettings, type TableSettings, type TableState } from './messages.js'
import type { Table } from './query.js'
import { TableWorker } from './session.js'
import { serveTable } from './transport.js'

export const TABLE = 'gridkitStudio.table'
export class CaseTable implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private port?: Port
  private viewSubscriptions: vscode.Disposable[] = []
  private state?: CaseState
  private subscription?: vscode.Disposable
  private readonly activated: vscode.Disposable
  private readonly settings = new Map<string, TableSettings>()
  private saveTimer?: ReturnType<typeof setTimeout>
  private server?: Service<never>
  private grid?: Table
  private readonly worker = new TableWorker()
  private binding = ''
  private recordingId?: string
  private refreshing?: Promise<void>
  private focusRequest = 0
  private readonly read = new Latest()
  private readonly following = new Latest()
  private serial = 0
  private settingsVersion = 0
  private classId = ''
  private message?: TableState
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cases: Cases,
    private readonly storage?: vscode.Memento,
  ) {
    for (const [key, value] of Object.entries(
      storage?.get<Record<string, unknown>>('table.settings') ?? {},
    ))
      if (isSettings(value)) this.settings.set(key, value)
    this.activated = cases.onDidActivate((state) => this.adopt(state))
  }
  private get preferences(): TableSettings {
    if (!this.state) return defaults()
    const key = `${this.state?.document.uri.toString()}\0${this.classId}`
    let value = this.settings.get(key)
    if (!value) {
      value = defaults()
      this.settings.set(key, value)
    }
    return value
  }
  private save(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void this.storage?.update('table.settings', Object.fromEntries(this.settings))
    }, 400)
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    this.port = webviewPort(view.webview)
    const messages = view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isRequest(message)) return
      if (message.type === 'ready') {
        this.adopt(this.cases.active)
        return
      }
      if (message.type === 'focus') {
        if (this.state) this.cases.focus(this.state)
        return
      }
      const state = this.cases.resolve(message.target)
      if (!state || state !== this.state) return
      if (message.type === 'focusReady') {
        if (message.grid === this.message?.grid && message.request === this.focusRequest) {
          this.view?.show(false)
          void vscode.commands
            .executeCommand(TABLE + '.focus', { preserveFocus: false })
            .then(() => {
              if (message.grid === this.message?.grid && message.request === this.focusRequest)
                this.port?.post({
                  type: 'focus-table',
                  grid: message.grid,
                  request: message.request,
                })
            })
        }
        return
      }
      if (message.type === 'filter') {
        void this.filter()
        return
      }
      if (message.type === 'select') {
        void this.cases.select(message.target, message.selection)
        return
      }
      if (message.grid !== this.message?.grid || message.settingsVersion !== this.settingsVersion)
        return
      Object.assign(this.preferences, message.settings)
      this.save()
    })
    this.viewSubscriptions.push(
      messages,
      view.onDidChangeVisibility(() => {
        if (view.visible) this.adopt(this.cases.active)
      }),
      view.onDidDispose(() => {
        for (const subscription of this.viewSubscriptions.splice(0)) subscription.dispose()
        this.subscription?.dispose()
        this.read.abort()
        this.following.abort()
        this.server?.close()
        this.server = undefined
        this.grid?.close()
        this.grid = undefined
        this.binding = ''
        this.view = undefined
        this.port = undefined
        void vscode.commands.executeCommand('setContext', 'gridkitStudio.tableReady', false)
      }),
    )
    view.webview.html = html(view.webview, this.extensionUri, 'table', '<main id="table"></main>')
  }
  private adopt(state: CaseState | undefined): void {
    this.subscription?.dispose()
    const changedState = this.state !== state
    if (changedState)
      this.classId =
        state?.selection?.element.classId ??
        this.storage?.get<string>(`table.class:${state?.document.uri.toString()}`) ??
        ''
    this.state = state
    this.subscription = state?.onDidChange((kind) => {
      if (kind === 'pending' || kind === 'draft') return
      if (kind === 'selection') void this.followSelection()
      else if (kind === 'time') this.updateTime()
      else if (kind === 'bindings') this.updateBindings()
      else if (kind === 'results' && this.sameRecordedColumns(state)) this.updateTime()
      else void this.refresh()
    })
    void this.refresh().then(() => {
      if (changedState && this.state === state && state?.selection) void this.followSelection()
    })
  }
  private sameRecordedColumns(state: CaseState): boolean {
    const shown = this.message?.columns
      .filter((column) => column.field?.source === 'signal')
      .map((column) => column.field!.id)
    const recorded = state.fields?.recorded(this.classId).map((field) => field.id)
    return this.recordingId === state.source?.id && shown?.join('\0') === recorded?.join('\0')
  }
  private updateContext(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'gridkitStudio.tableReady',
      !!this.message?.grid,
    )
    void vscode.commands.executeCommand(
      'setContext',
      'gridkitStudio.tableFiltered',
      !!this.preferences.query,
    )
  }
  private post(): void {
    if (!this.port || !this.message) return
    this.message = {
      ...this.message,
      focusRequest: this.focusRequest,
      settings: { ...this.preferences },
      settingsVersion: this.settingsVersion,
    }
    this.port.post(this.message)
    this.updateContext()
  }
  private updateBindings(): void {
    const state = this.state
    const fields = state?.fields
    if (!state || !fields || !this.message?.grid) return
    const { model } = fields
    const columns = this.message.columns.map((column) => {
      const field = column.field
      return {
        ...column,
        bindable: !!field && column.numeric && channelsFor(model, field).length > 0,
        bound: !!field && bound(state.bindings, this.classId, field),
      }
    })
    this.message = {
      ...this.message,
      columns,
      capabilities: {
        ...classCapabilities(
          model,
          this.classId,
          columns.some((column) => column.numeric),
          state.bindings,
        ),
        plot: fields.recorded(this.classId).length > 0,
      },
    }
    this.post()
  }
  private updateTime(): void {
    if (!this.view?.visible || !this.message?.grid || !this.state?.source) return
    this.message = {
      ...this.message,
      time: this.state.timeline.time,
      frame: this.state.timeline.frame,
      frameCount: this.state.source.info?.rows,
      tick: (this.message.tick ?? 0) + 1,
    }
    this.port?.post({
      type: 'time',
      grid: this.message.grid,
      time: this.message.time,
      frame: this.message.frame,
      frameCount: this.message.frameCount,
      tick: this.message.tick,
    })
  }
  private refresh(): Promise<void> {
    if (!this.view || !this.port) return Promise.resolve()
    const state = this.state
    const model = state?.fields?.model
    const spec = model?.classes.find((cls) => cls.id === this.classId) ?? model?.classes[0]
    const key = JSON.stringify([
      state?.target,
      spec?.id,
      state?.source?.id,
      spec ? state?.fields?.recorded(spec.id).map((field) => field.id) : [],
    ])
    if (this.binding === key && (this.grid || this.refreshing)) {
      if (this.refreshing) return this.refreshing
      this.post()
      this.updateTime()
      return Promise.resolve()
    }
    this.binding = key
    const pending = this.rebuild()
    this.refreshing = pending
    void pending.finally(() => {
      if (this.refreshing === pending) this.refreshing = undefined
    })
    return pending
  }
  private async rebuild(): Promise<void> {
    const signal = this.read.next()
    this.following.abort()
    this.server?.close()
    this.server = undefined
    this.grid?.close()
    this.grid = undefined
    const view = this.view
    const state = this.state
    if (!view || !this.port) return
    const target = state?.target
    const fields = state?.fields
    const model = fields?.model
    const spec = model?.classes.find((cls) => cls.id === this.classId) ?? model?.classes[0]
    if (model) this.classId = spec?.id ?? ''
    this.settingsVersion++
    this.message = {
      type: 'table',
      target,
      name: model?.name ?? 'Case',
      status: !state
        ? 'Open a .case.json file to inspect its data.'
        : state.snapshot.state === 'invalid'
          ? state.snapshot.issues[0].message
          : !model
            ? 'Updating case...'
            : !spec
              ? 'This case has no elements.'
              : 'Loading rows...',
      classId: this.classId,
      classLabel: spec?.label ?? '',
      columns: [],
      selection: state?.selection ?? null,
      settings: this.preferences,
      settingsVersion: this.settingsVersion,
      capabilities: NO_CAPABILITIES,
    }
    this.post()
    if (!state || !target || !fields || !model || !spec) return
    try {
      const data = await model.load(spec.id, signal)
      if (signal.aborted || !state.current(target) || this.view !== view) return
      const name = `${target.revision}:${++this.serial}:${spec.id}`
      const recorded = fields.recorded(spec.id)
      this.recordingId = state.source?.id
      const grid =
        recorded.length && fields.source
          ? await fields.source.openTable(data, recorded, signal)
          : await this.worker.open(data, signal)
      if (signal.aborted || !state.current(target) || this.view !== view) {
        grid.close()
        return
      }
      this.grid = grid
      const columns = [
        ...tableColumns(data, spec.id),
        ...recorded.map((field, i) => ({
          id: tableFieldId(field),
          field,
          label: data.columns.some((column) => column.label === field.label)
            ? `${field.label} (recorded)`
            : field.label,
          group: 'Recorded',
          numeric: true,
          identity: false,
          width: 130,
          index: data.columns.length + i,
        })),
      ]
      this.server = serveTable(this.port, name, this.grid)
      this.message = {
        ...this.message!,
        status: '',
        grid: name,
        rowCount: spec.count,
        time: recorded.length ? state.timeline.time : undefined,
        frame: state.timeline.frame,
        frameCount: state.source?.info?.rows,
        selection: state.selection,
        columns: columns.map((column) => ({ ...column, bindable: false, bound: false })),
      }
      this.updateBindings()
    } catch (error) {
      if (!signal.aborted) {
        this.message = { ...this.message!, status: `Cannot load case data: ${describe(error)}` }
        this.post()
      }
    }
  }
  private async followSelection(): Promise<void> {
    const state = this.state
    const selection = state?.selection
    const target = state?.target
    this.following.abort()
    if (!state || !target) return
    if (selection && selection.element.classId !== this.classId) {
      this.classId = selection.element.classId
      await this.refresh()
    }
    if (this.state !== state || state.selection !== selection || !state.current(target)) return
    const signal = this.following.next()
    const grid = this.grid
    if (!grid || !this.message) return
    if (selection) {
      const settings = this.preferences
      try {
        const view = await grid.query(
          {
            filter: settings.query,
            sort: settings.sort,
            time: state.timeline.time,
            frame: state.timeline.frame,
            frameCount: state.source?.info?.rows,
          },
          signal,
        )
        let position: number | null
        try {
          position = await view.locate(selection.element.index, signal)
        } finally {
          view.close()
        }
        if (
          signal.aborted ||
          !state.current(target) ||
          state.selection !== selection ||
          this.state !== state
        )
          return
        if (position === null && settings.query) {
          settings.query = ''
          settings.scrollTop = 0
          this.settingsVersion++
        }
        if (selection.field) this.ensureColumn(tableFieldId(selection.field))
      } catch {
        return
      }
    }
    this.message = { ...this.message, selection: selection ?? null }
    this.post()
    this.save()
  }
  private ensureColumn(id: string): void {
    const settings = this.preferences
    if (settings.visible && !settings.visible.includes(id)) {
      settings.visible = [...settings.visible, id]
      this.settingsVersion++
    }
  }
  async show(state: CaseState, classId?: string, fieldId?: string): Promise<void> {
    this.cases.focus(state)
    if (classId) this.classId = classId
    await vscode.commands.executeCommand(`${TABLE}.focus`, { preserveFocus: !!this.view })
    await this.refresh()
    if (fieldId) this.ensureColumn(fieldId)
    if (state.selection?.element.classId === this.classId) await this.followSelection()
    else this.post()
    this.view?.show(false)
    this.focusRequest++
    this.post()
  }
  async selectClass(): Promise<void> {
    const state = this.state
    const target = state?.target
    if (!state?.fields || !target) return
    const choice = await vscode.window.showQuickPick(
      state.fields.model.classes.map((cls) => ({
        label: cls.label,
        description: `${cls.count.toLocaleString()} elements`,
        id: cls.id,
      })),
      { placeHolder: 'Select element class' },
    )
    if (!choice || this.state !== state || !state.current(target)) return
    this.classId = choice.id
    void this.storage?.update(`table.class:${target.uri}`, choice.id)
    await this.refresh()
  }
  async filter(): Promise<void> {
    const state = this.state
    const target = state?.target
    const classId = this.classId
    if (!state?.fields || !target || !this.message?.grid) return
    const settings = this.preferences
    const before = settings.query
    const current = () => this.state === state && this.classId === classId && state.current(target)
    const input = vscode.window.createInputBox()
    input.title = `Filter ${state.fields.model.classes.find((cls) => cls.id === classId)!.label}`
    input.placeholder = 'Filter rows'
    input.value = before
    let accepted = false
    const changed = input.onDidChangeValue((query) => {
      if (current()) {
        settings.query = query
        settings.scrollTop = 0
        this.settingsVersion++
        this.post()
      }
    })
    const accept = input.onDidAccept(() => {
      accepted = current()
      input.hide()
    })
    const revision = state.onDidChange(() => {
      if (!current()) input.hide()
    })
    await new Promise<void>((resolve) => {
      const hide = input.onDidHide(() => {
        if (!accepted) settings.query = before
        changed.dispose()
        accept.dispose()
        revision.dispose()
        hide.dispose()
        input.dispose()
        if (current()) {
          this.settingsVersion++
          this.post()
        }
        this.save()
        resolve()
      })
      input.show()
    })
  }
  clearFilter(): void {
    this.preferences.query = ''
    this.preferences.scrollTop = 0
    this.settingsVersion++
    this.post()
    this.save()
  }
  async chooseColumns(): Promise<void> {
    const state = this.state
    const target = state?.target
    const classId = this.classId
    const columns = this.message?.columns
    if (!state || !target || !columns) return
    const settings = this.preferences
    const choices = columns
      .filter((column) => !column.identity)
      .map((column) => ({
        label: column.label,
        description: column.id!,
        id: column.id!,
        picked: settings.visible
          ? settings.visible.includes(column.id!)
          : column.id !== 'top.class',
      }))
    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Choose visible columns',
      canPickMany: true,
      matchOnDescription: true,
    })
    if (!selected || this.state !== state || this.classId !== classId || !state.current(target))
      return
    settings.visible = selected.map((column) => column.id)
    this.settingsVersion++
    this.post()
    this.save()
  }
  resetColumns(): void {
    delete this.preferences.visible
    this.preferences.widths = {}
    this.settingsVersion++
    this.post()
    this.save()
  }
  dispose(): void {
    clearTimeout(this.saveTimer)
    void this.storage?.update('table.settings', Object.fromEntries(this.settings))
    this.activated.dispose()
    this.subscription?.dispose()
    this.read.abort()
    this.following.abort()
    this.server?.close()
    this.grid?.close()
    this.worker.close()
    for (const subscription of this.viewSubscriptions.splice(0)) subscription.dispose()
    this.view = undefined
    this.port = undefined
  }
}
