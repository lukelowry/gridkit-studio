import { expect, it } from 'vitest'
import type * as vscode from 'vscode'

import { registerActions } from '../src/actions.js'
import { Cases } from '../src/case.js'
import { Documents } from '../src/documents.js'
import type { NetworkEditor } from '../src/network/editor.js'
import type { CaseTable } from '../src/table/view.js'
import { caseText } from './support/case.js'
import { commands, window } from './support/vscode.js'

function setup() {
  const documents = new Documents()
  const cases = new Cases(documents)
  const make = (path: string) =>
    cases.get({
      uri: { path, toString: () => `file://${path}` },
      version: 1,
      isClosed: false,
      languageId: 'json',
      getText: () => caseText({ buses: [{ number: 1, params: { x: 10 } }] }),
      positionAt: (character: number) => ({ line: 0, character }),
    } as unknown as vscode.TextDocument)
  const a = make('/a.case.json')
  const b = make('/b.case.json')
  commands.registerCommand.mockClear()
  const subscriptions: vscode.Disposable[] = []
  registerActions(
    { subscriptions } as unknown as vscode.ExtensionContext,
    cases,
    {} as NetworkEditor,
    {} as CaseTable,
  )
  const bind = commands.registerCommand.mock.calls.find(
    ([id]) => id === 'gridkitStudio.bind',
  )![1] as (arg: unknown) => Promise<void>
  const target = { ...a.target, field: { classId: 'bus', source: 'column', id: 'params.x' } }
  return {
    a,
    b,
    cases,
    documents,
    bind,
    target,
    dispose: () => {
      cases.dispose()
      documents.dispose()
    },
  }
}
it('an awaited native binding picker stays with its captured case after focus changes', async () => {
  const test = setup()
  let choose!: (value: unknown) => void
  window.showQuickPick.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        choose = resolve
      }),
  )
  const pending = test.bind({ gridkitTarget: test.target })
  test.cases.activate(test.b)
  choose({ channel: 'vertexColor' })
  await pending
  expect(test.a.bindings.vertexColor?.field.id).toBe('params.x')
  expect(test.b.bindings).toEqual({})
  test.dispose()
})
it('an edit while a native picker is open rejects its eventual choice', async () => {
  const test = setup()
  let choose!: (value: unknown) => void
  window.showQuickPick.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        choose = resolve
      }),
  )
  const pending = test.bind({ gridkitTarget: test.target })
  Object.assign(test.a.document, { version: 2 })
  test.a.update({ state: 'pending', version: 2 })
  choose({ channel: 'vertexColor' })
  await pending
  expect(test.a.bindings).toEqual({})
  test.dispose()
})
