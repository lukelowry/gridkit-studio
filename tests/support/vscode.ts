import { vi } from 'vitest'
import type * as vscode from 'vscode'

export const ViewColumn = { Active: -1, Beside: -2 }
export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 }
export const EndOfLine = { LF: 1, CRLF: 2 }
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 }
export class TreeItem {
  constructor(
    public label: string,
    public collapsibleState = 0,
  ) {}
}
export class ThemeIcon {
  constructor(public id: string) {}
}

export const commands = {
  executeCommand: vi.fn(),
  registerCommand:
    vi.fn<(id: string, callback: (uri?: vscode.Uri) => unknown) => vscode.Disposable>(),
}

export class EventEmitter<T> {
  private listeners = new Set<(event: T) => unknown>()
  event = (listener: (event: T) => unknown) => {
    this.listeners.add(listener)
    return {
      dispose: () => {
        this.listeners.delete(listener)
      },
    }
  }
  fire(event: T) {
    for (const listener of this.listeners) listener(event)
  }
  dispose() {
    this.listeners.clear()
  }
}

export class Range {
  constructor(
    public start: vscode.Position,
    public end: vscode.Position,
  ) {}
}
export class Diagnostic {
  source?: string
  constructor(
    public range: vscode.Range,
    public message: string,
    public severity: number,
  ) {}
}
export const DiagnosticSeverity = { Error: 0 }
export const languages = {
  createDiagnosticCollection: () => ({ set: vi.fn(), delete: vi.fn(), dispose: vi.fn() }),
}
export const events = {
  open: new EventEmitter<vscode.TextDocument>(),
  change: new EventEmitter<vscode.TextDocumentChangeEvent>(),
  close: new EventEmitter<vscode.TextDocument>(),
}
export const workspace = {
  textDocuments: [] as vscode.TextDocument[],
  onDidOpenTextDocument: events.open.event,
  onDidChangeTextDocument: events.change.event,
  onDidCloseTextDocument: events.close.event,
  openTextDocument: vi.fn<(uri: vscode.Uri) => Promise<vscode.TextDocument>>(),
}

export const activeEditorChanged = new EventEmitter<vscode.TextEditor | undefined>()
export const statusItems: Array<{
  text: string
  name: string
  tooltip?: string
  command?: vscode.Command
  show: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  dispose(): void
}> = []
export const tabsChanged = new EventEmitter<vscode.TabChangeEvent>()
export const window = {
  tabGroups: { onDidChangeTabs: tabsChanged.event, activeTabGroup: { activeTab: undefined } },
  createStatusBarItem: () => {
    const item = {
      text: '',
      name: '',
      tooltip: undefined,
      command: undefined,
      accessibilityInformation: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose() {},
    }
    statusItems.push(item)
    return item
  },
  onDidChangeActiveTextEditor: activeEditorChanged.event,
  registerWebviewViewProvider: vi.fn(),
  createTreeView: () => ({
    dispose() {},
    description: undefined,
    message: undefined,
    onDidChangeCheckboxState: new EventEmitter<unknown>().event,
  }),
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showSaveDialog: vi.fn(),
  visibleTextEditors: [] as vscode.TextEditor[],
  registerCustomEditorProvider: vi.fn(),
  activeTextEditor: undefined as vscode.TextEditor | undefined,
  showOpenDialog: vi.fn<(options: vscode.OpenDialogOptions) => Promise<vscode.Uri[] | undefined>>(),
  showTextDocument:
    vi.fn<
      (document: vscode.TextDocument, options: vscode.TextDocumentShowOptions) => Promise<unknown>
    >(),
  showInformationMessage: vi.fn<(message: string) => Promise<unknown>>(),
  showErrorMessage: vi.fn<(message: string) => Promise<unknown>>(),
}

export const StatusBarAlignment = { Left: 1, Right: 2 }
export class TabInputText {
  constructor(public uri: vscode.Uri) {}
}
export class TabInputCustom {
  constructor(
    public uri: vscode.Uri,
    public viewType: string,
  ) {}
}

export const tasks = { registerTaskProvider: vi.fn(), executeTask: vi.fn() }

export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => fsPath }),
}
