/** Sessions: what a case records, which its own `mon` lists say, the results file a session reads
 *  again when its case opens, and the plots a new run keeps. */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { setup, suite, test } from 'mocha'
import * as vscode from 'vscode'

import { plotsFor, type Sessions } from '../../src/extension/sessions.js'
import type { SimulationInfo } from '../../src/shared/messages.js'
import { extension, folder, until } from './harness.js'

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

  test('a case records what its own lists name', async () => {
    const source = JSON.parse(document.getText()) as {
      buses: { mon?: string[] }[]
      devices: { class: string; mon?: string[] }[]
    }
    const listed: Record<string, Record<string, number>> = {}
    for (const { type, mon = [] } of [
      ...source.buses.map(({ mon }) => ({ type: 'Bus', mon })),
      ...source.devices.map(({ class: type, mon }) => ({ type, mon })),
    ])
      for (const name of mon) (listed[type] ??= {})[name] = (listed[type]?.[name] ?? 0) + 1
    assert.deepEqual((await studio.documents.ensure(document)).recording.listed, listed)
  })

  test('records a field by writing it in the case, one edit for every element', async () => {
    const key = document.uri.toString()
    const { version, counts } = await studio.documents.ensure(document)
    await studio.documents.transact(
      key,
      version,
      [{ kind: 'record', type: 'Bus', add: ['Vm'], remove: [] }],
      'Record Bus Vm',
    )
    const buses = JSON.parse(document.getText()).buses as { mon?: string[] }[]
    assert.ok(buses.every((bus) => bus.mon?.includes('Vm')))
    await until(
      async () => (await studio.documents.ensure(document)).recording.listed.Bus?.Vm === counts.Bus,
      'every bus records Vm',
    )
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
    await studio.context.workspaceState.update(gone, { plots: [] })
    await studio.prune()
    const keys = studio.context.workspaceState.keys()
    assert.ok(!keys.includes(gone), 'A deleted case keeps no saved state')
    assert.ok(keys.includes('case:' + session.uri), 'An existing case keeps its saved state')
  })

  test('reads the results file it showed again when the case opens, and forgets one gone', async () => {
    const session = studio.current()
    const { buses } = JSON.parse(document.getText()) as { buses: { name: string }[] }
    const csv = vscode.Uri.joinPath(folder(), `results-${randomUUID()}.csv`)
    await vscode.workspace.fs.writeFile(
      csv,
      new TextEncoder().encode(`time,Bus_${buses[0]!.name}_Vm\n0,1\n0.5,0.9\n1,1\n`),
    )
    const info = await studio.client.call('open', {
      uri: session.uri,
      version: (await studio.documents.ensure(document)).version,
      path: csv.fsPath,
      cacheBytes: 16 << 20,
    })
    studio.show(session, info)
    await studio.persist(session)
    /** The case opened again, as after a reload: a session of its own, read anew. */
    const reopen = async () => {
      studio.all.get(session.uri)?.transport.dispose()
      studio.all.delete(session.uri)
      return studio.open(document)
    }
    const restored = await reopen()
    await until(() => restored.run?.path === csv.fsPath, 'the file read again')
    assert.equal(restored.run!.frames, 3)
    await vscode.workspace.fs.delete(csv)
    const forgetting = await reopen()
    await until(
      () =>
        !(studio.context.workspaceState.get<{ results?: unknown }>('case:' + session.uri) ?? {})
          .results,
      'a file that is gone is forgotten',
    )
    assert.equal(forgetting.run, undefined)
  })
})
