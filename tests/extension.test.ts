import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { activate } from '../src/extension.js'
import { caseText } from './support/case.js'
import { inlineParser } from './support/parser.js'
import { commands, window, workspace } from './support/vscode.js'

const uri = (path: string) => ({ path }) as vscode.Uri
const caseUri = uri('/cases/two-bus.case.json')
const document = (
  resource = caseUri,
  text = caseText({
    header: { case_name: 'Unsaved case' },
    buses: [{ number: 1 }, { number: 2 }],
    devices: [{ class: 'Branch', ports: { bus1: 1, bus2: 2 } }],
  }),
) =>
  ({
    uri: resource,
    version: 1,
    languageId: 'json',
    getText: () => text,
    positionAt: (character: number) => ({ line: 0, character }),
  }) as vscode.TextDocument

function execute(name: string, resource?: vscode.Uri) {
  const command = commands.registerCommand.mock.calls.find(([id]) => id === `gridkitStudio.${name}`)
  if (!command) throw new Error(`Command not registered: ${name}`)
  return command[1](resource)
}

let subscriptions: vscode.Disposable[]
afterEach(() => {
  for (const item of subscriptions) item?.dispose()
})

beforeEach(() => {
  vi.resetAllMocks()
  window.activeTextEditor = undefined
  subscriptions = []
  activate({ subscriptions } as unknown as vscode.ExtensionContext)
})

vi.mock('../src/parser/client.js', () => ({
  Parser: class {
    parse = inlineParser.parse
    dispose = inlineParser.dispose
  },
}))

describe('case commands', () => {
  it('finishes validation without waiting for notification dismissal', async () => {
    const current = document()
    window.activeTextEditor = { document: current } as vscode.TextEditor
    workspace.openTextDocument.mockResolvedValue(current)
    window.showInformationMessage.mockReturnValue(new Promise(() => {}))

    expect(await execute('validateCase')).toEqual({ name: 'Unsaved case', buses: 2, branches: 1 })
  })

  it('honors an Explorer target with an uppercase case suffix', async () => {
    const target = uri('/cases/GRID.CASE.JSON')
    window.activeTextEditor = { document: document() } as vscode.TextEditor
    workspace.openTextDocument.mockResolvedValue(document(target))

    expect(await execute('validateCase', target)).toMatchObject({ buses: 2 })
    expect(workspace.openTextDocument).toHaveBeenCalledWith(target)
  })

  it('opens the selected case as a persistent network in the current group', async () => {
    const current = document()
    window.showOpenDialog.mockResolvedValue([caseUri])
    workspace.openTextDocument.mockResolvedValue(current)

    await execute('openCase')
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      caseUri,
      'gridkitStudio.network',
      {
        viewColumn: -1,
        preview: false,
      },
    )
    expect(window.showTextDocument).not.toHaveBeenCalled()
    expect(window.showInformationMessage).not.toHaveBeenCalled()
  })

  it('opens the active JSON document as a network without creating a split', async () => {
    const current = document()
    window.activeTextEditor = { document: current } as vscode.TextEditor
    workspace.openTextDocument.mockResolvedValue(current)

    await execute('preview')
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      caseUri,
      'gridkitStudio.network',
      {
        viewColumn: -1,
        preview: false,
      },
    )
    expect(window.showOpenDialog).not.toHaveBeenCalled()
  })

  it('does nothing when the file picker is cancelled', async () => {
    window.showOpenDialog.mockResolvedValue(undefined)
    expect(await execute('openCase')).toBeUndefined()
    expect(workspace.openTextDocument).not.toHaveBeenCalled()
    expect(window.showErrorMessage).not.toHaveBeenCalled()
  })

  it('opens an invalid case so the network can offer JSON recovery', async () => {
    const current = document(caseUri, '{ broken')
    workspace.openTextDocument.mockResolvedValue(current)

    expect(await execute('openCase', caseUri)).toBeUndefined()
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      caseUri,
      'gridkitStudio.network',
      {
        viewColumn: -1,
        preview: false,
      },
    )
    expect(window.showErrorMessage).not.toHaveBeenCalled()
    expect(window.showInformationMessage).not.toHaveBeenCalled()
  })

  it('reports unreadable resources', async () => {
    workspace.openTextDocument.mockRejectedValue(new Error('File not found'))

    expect(await execute('validateCase', caseUri)).toBeUndefined()
    expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('File not found'))
  })

  it('rejects unrelated files before opening them', async () => {
    expect(await execute('openCase', uri('/settings.json'))).toBeUndefined()
    expect(workspace.openTextDocument).not.toHaveBeenCalled()
    expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('.case.json'))
  })

  it('explains how to open a case when no document is active', async () => {
    expect(await execute('validateCase')).toBeUndefined()
    expect(workspace.openTextDocument).not.toHaveBeenCalled()
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Open Case'))
  })
})
