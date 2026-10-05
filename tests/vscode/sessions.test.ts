import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { setup, suite, test } from 'mocha'
import * as vscode from 'vscode'

import { plotsFor, type Sessions } from '../../src/extension/sessions.js'
import type { RunInfo } from '../../src/shared/messages.js'

suite('Sessions', () => {
  let studio: Sessions
  let document: vscode.TextDocument

  setup(async () => {
    const extension = vscode.extensions.getExtension<{ studio: Sessions }>(
      'lukelowery.gridkit-studio',
    )!
    studio = (await extension.activate()).studio
    const folder = vscode.workspace.workspaceFolders![0]!.uri
    const uri = vscode.Uri.joinPath(folder, `recording-${randomUUID()}.case.json`)
    await vscode.workspace.fs.copy(vscode.Uri.joinPath(folder, 'IEEE39.case.json'), uri)
    document = await vscode.workspace.openTextDocument(uri)
    await studio.open(document)
  })

  test('keeps an empty recording selection when the case is opened again', async () => {
    const session = studio.current()
    studio.record(session.uri, [])
    assert.deepEqual(session.outputs, [])
    await studio.open(document)
    assert.deepEqual(session.outputs, [])
  })

  test('drops the results format saved by older prereleases', async () => {
    const session = studio.current()
    session.values = { tmax: 2, output_format: 'arrow' }
    await studio.persist(session)
    session.transport.dispose()
    studio.all.delete(session.uri)
    const restored = await studio.open(document)
    assert.deepEqual(restored.values, { tmax: 2 })
  })

  test('a new run keeps the plots it recorded, else plots its first signal', () => {
    const run = { outputs: [{ from: 'Bus', select: ['Va', 'Vm'] }] } as unknown as RunInfo
    const vm = { from: 'Bus', field: 'Vm' }
    assert.deepEqual(plotsFor(run, [vm, { from: 'Bus', field: 'Pg' }]), [vm])
    assert.deepEqual(plotsFor(run, [{ from: 'Gen', field: 'Pg' }]), [{ from: 'Bus', field: 'Va' }])
    assert.deepEqual(plotsFor({ outputs: [] } as unknown as RunInfo, [vm]), [])
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
