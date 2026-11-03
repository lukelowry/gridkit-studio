/** Editing the case: each change one edit of the document, which VS Code's own undo takes back,
 *  made from the views' menus as their pages ask for it. */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { setup, suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { type Bench, bench, folder, until } from './studio.js'

suite('Editing', () => {
  let host: Bench
  /** The block the Diagram suites rewire and delete: a power system stabilizer. */
  const id = '30_1_ieeest'
  const block = () =>
    (
      JSON.parse(host.document.getText()) as {
        devices: { id: string; ports: Record<string, unknown> }[]
      }
    ).devices.find((device) => device.id === id)

  suiteSetup(async () => {
    host = await bench()
  })
  setup(() => host.reset())

  test('edits a field as one change, which undo and redo take back and forth', async () => {
    const [bus] = host.source.buses
    const { version } = await host.studio.documents.ensure(host.document)
    await host.studio.documents.edit(
      host.key,
      version,
      { table: 'Bus', id: bus!.number, field: 'params.kv' },
      bus!.params.kv + 1,
    )
    assert.equal(JSON.parse(host.document.getText()).buses[0].params.kv, bus!.params.kv + 1)
    await host.undo()
    await vscode.commands.executeCommand('redo')
    await until(() => host.document.getText() !== host.text, 'redone')
    await host.settled()
    await host.undo()
  })

  test('refuses an edit made against an older revision', async () => {
    const { version } = await host.studio.documents.ensure(host.document)
    await assert.rejects(
      host.studio.documents.edit(
        host.key,
        version - 1,
        { table: 'Bus', id: host.source.buses[0]!.number, field: 'params.kv' },
        1,
      ),
      /changed/,
    )
  })

  test('changes only the edited field, as Git sees the saved text', async () => {
    const git = (...args: string[]) =>
      promisify(execFile)('git', ['-C', folder().fsPath, ...args], { windowsHide: true })
    await git('init', '--quiet')
    await git('add', '--', 'IEEE39.case.json')
    await git(
      ...['-c', 'user.name=GridKit Test', '-c', 'user.email=test@example.invalid'],
      ...['commit', '--quiet', '-m', 'As found'],
    )
    const [bus] = host.source.buses
    await host.studio.documents.edit(
      host.key,
      (await host.studio.documents.ensure(host.document)).version,
      { table: 'Bus', id: bus!.number, field: 'params.kv' },
      bus!.params.kv + 1,
    )
    await host.document.save()
    // One line out, one line in: the case is never written again whole.
    const { stdout } = await git('diff', '--numstat', '--', 'IEEE39.case.json')
    assert.match(stdout, /^1\t1\t/)
  })

  test("disconnects a port from the Diagram's menu, which undo wires again", async () => {
    assert.notEqual(block()?.ports.output, null)
    await host.menu(
      { origin: 'diagram', element: { table: 'Ieeest', id, field: 'ports.output' } },
      'Disconnect Port',
    )
    assert.equal(block()?.ports.output, null)
    await host.undo()
  })

  test("deletes a block from the Diagram's menu, which undo brings back", async () => {
    await host.menu({ origin: 'diagram', element: { table: 'Ieeest', id } }, 'Delete Element')
    assert.equal(block(), undefined)
    await host.undo()
  })

  test('writes an arrangement into the case as one change, which undo takes back', async () => {
    // What the Diagram asks for once latkit has placed its blocks: every block's place.
    const { version } = await host.studio.documents.ensure(host.document)
    const devices = host.source.devices.filter((device) => device.class === 'Ieeest')
    await host.studio.documents.transact(
      host.key,
      version,
      devices.map((device, i) => ({
        kind: 'move' as const,
        entity: { table: 'Ieeest', id: device.id },
        position: [i * 100, 0] as const,
      })),
      'Arrange diagram',
    )
    const { devices: placed } = JSON.parse(host.document.getText()) as {
      devices: { class: string; extension?: { diagram?: unknown } }[]
    }
    assert.ok(
      placed.filter((device) => device.class === 'Ieeest').every((d) => d.extension?.diagram),
    )
    await host.undo()
  })
})
