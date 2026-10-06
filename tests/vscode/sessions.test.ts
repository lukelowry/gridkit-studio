/** Sessions: the signals a case records, how they persist in workspace storage, and the plots a
 *  new run keeps. */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { setup, suite, test } from 'mocha'
import * as vscode from 'vscode'

import { plotsFor, type Sessions } from '../../src/extension/sessions.js'
import type { SimulationInfo } from '../../src/shared/messages.js'
import { extension, folder } from './harness.js'

suite('Sessions', () => {
  let studio: Sessions
  let document: vscode.TextDocument

  setup(async () => {
    studio = (await extension().activate()).studio
    const uri = vscode.Uri.joinPath(folder(), `recording-${randomUUID()}.case.json`)
    await vscode.workspace.fs.copy(vscode.Uri.joinPath(folder(), 'IEEE39.case.json'), uri)
    document = await vscode.workspace.openTextDocument(uri)
    await studio.open(document)
  })

  test("records each bus's voltage magnitude and angle until the user chooses", () => {
    assert.deepEqual(studio.current().outputs, [{ from: 'Bus', select: ['Vm', 'Va'] }])
  })

  test('keeps an empty recording selection when the case is opened again', async () => {
    const session = studio.current()
    studio.record(session.uri, [])
    assert.deepEqual(session.outputs, [])
    await studio.open(document)
    assert.deepEqual(session.outputs, [])
  })

  test('a new run keeps the plots it recorded, else plots its first signal', () => {
    const run = { outputs: [{ from: 'Bus', select: ['Va', 'Vm'] }] } as unknown as SimulationInfo
    const vm = { from: 'Bus', field: 'Vm' }
    assert.deepEqual(plotsFor(run, [vm, { from: 'Bus', field: 'Pg' }]), [vm])
    assert.deepEqual(plotsFor(run, [{ from: 'Gen', field: 'Pg' }]), [{ from: 'Bus', field: 'Va' }])
    assert.deepEqual(plotsFor({ outputs: [] } as unknown as SimulationInfo, [vm]), [])
  })

  test('forgets cases deleted while it was closed, and keeps those that exist', async () => {
    const session = studio.current()
    await studio.persist(session)
    const gone = 'case:' + vscode.Uri.joinPath(folder(), `gone-${randomUUID()}.case.json`)
    await studio.context.workspaceState.update(gone, { values: {} })
    await studio.prune()
    const keys = studio.context.workspaceState.keys()
    assert.ok(!keys.includes(gone), 'A deleted case keeps no saved state')
    assert.ok(keys.includes('case:' + session.uri), 'An existing case keeps its saved state')
  })

  for (const outputs of [[], [{ from: 'Bus', select: ['Vm'] }]])
    test(`restores ${outputs.length ? 'chosen' : 'empty'} recordings from workspace storage`, async () => {
      const session = studio.current()
      session.outputs = outputs
      await studio.persist(session)
      session.transport.dispose()
      studio.all.delete(session.uri)
      const restored = await studio.open(document)
      assert.deepEqual(restored.outputs, outputs)
    })
})
