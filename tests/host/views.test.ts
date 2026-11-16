/** The active case, editors closing during a change, and revealing undrawn elements. Rendering is
 *  covered by the e2e journeys. */

import assert from 'node:assert/strict'

import { setup, suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { menuContext } from '../../src/shared/menus.js'
import { type Bench, bench, until } from './studio.js'

suite('Views', () => {
  let host: Bench

  suiteSetup(async () => {
    host = await bench()
  })
  setup(() => host.reset())

  test('follow the case of the canvas in front, and the case a command names', async () => {
    const other = await host.copy('cases/TwoArea.case.json')
    await vscode.commands.executeCommand('vscode.openWith', other, 'gridkitStudio.network')
    await until(() => host.studio.active === other.toString(), 'TwoArea followed')
    await vscode.commands.executeCommand('vscode.openWith', host.uri, 'gridkitStudio.network')
    await until(() => host.studio.active === host.key, 'IEEE39 followed')
    await vscode.commands.executeCommand('gridkitStudio.openCasePanel', other)
    await until(() => host.studio.active === other.toString(), 'the case the command names')
    assert.equal(host.studio.state(other.toString()).summary?.name, 'TwoArea')
  })

  test('report no error when an editor closes as its case changes', async () => {
    // VS Code disposes an editor before the extension host is told, so a change in between must not
    // query the disposed panel. The two race, so try several offsets many times.
    for (let cycle = 0; cycle < 30; cycle++) {
      await vscode.commands.executeCommand('vscode.openWith', host.uri, 'gridkitStudio.network')
      const closing = vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await new Promise((resolve) => setTimeout(resolve, cycle % 4))
      host.studio
        .get(host.key)
        ?.map({ table: 'Bus', field: 'init.Vr' }, cycle % 2 ? ['vertexColor'] : [])
      await closing
    }
    assert.deepEqual(host.takeErrors(), [])
  })

  test('reveal an element the Network does not draw by the bus it reaches', async () => {
    const summary = await host.studio.files.read(host.key)
    // The Network does not draw exciters; this one is on bus 30.
    const exciter = { table: 'Esdc1a', id: '30_1_esdc1a' }
    const menu = menuContext(summary, {
      uri: host.key,
      version: summary.version,
      origin: 'case',
      element: exciter,
    })
    const keys = { ...host.keys(), ...menu }
    host.session.select()
    const reveal = host.menus.find('webview/context', 'Reveal in Network', keys)
    await vscode.commands.executeCommand(reveal.command, menu)
    assert.deepEqual(host.session.selection, exciter)
    await until(() => host.session.networkSelection, 'the bus it reaches')
    assert.deepEqual(host.session.networkSelection, [{ table: 'Bus', id: 30 }])
  })

  test('list a monitor per recorded signal, shown, split and stepped through as terminals are', async () => {
    await host.recordOnly('Bus', ['Vm', 'Va'])
    const { session } = host
    const fields = (monitors: readonly { field: string }[]) => monitors.map(({ field }) => field)
    await until(() => session.monitors.length === 2, 'a monitor per recorded signal')
    const [first, second] = session.monitors
    assert.deepEqual(new Set(fields(session.monitors)), new Set(['Vm', 'Va']))
    assert.deepEqual(fields(session.shown), [first!.field])
    // Next Monitor wraps around the list, as Focus Next Terminal does.
    await vscode.commands.executeCommand('gridkitStudio.nextMonitor')
    assert.deepEqual(fields(session.shown), [second!.field])
    await vscode.commands.executeCommand('gridkitStudio.nextMonitor')
    assert.deepEqual(fields(session.shown), [first!.field])
    // A row's menu splits a monitor beside the one shown, and unsplits it again.
    const summary = await host.studio.files.read(host.key)
    const rowMenu = (monitor: typeof first) =>
      menuContext(
        summary,
        { uri: host.key, version: summary.version, origin: 'monitor', field: monitor, monitor },
        { mappings: session.mappings, monitors: session.shown },
      )
    const split = rowMenu(second)
    const splitItem = host.menus.find('webview/context', 'Split Monitor', {
      ...host.keys(),
      ...split,
    })
    await vscode.commands.executeCommand(splitItem.command, split)
    assert.deepEqual(fields(session.shown), fields(session.monitors))
    assert.equal(host.studio.contexts.get('canSplit'), false)
    const unsplit = rowMenu(second)
    const unsplitItem = host.menus.find('webview/context', 'Unsplit Monitor', {
      ...host.keys(),
      ...unsplit,
    })
    await vscode.commands.executeCommand(unsplitItem.command, unsplit)
    assert.deepEqual(fields(session.shown), [first!.field])
    assert.equal(host.studio.contexts.get('canSplit'), true)
  })
})
