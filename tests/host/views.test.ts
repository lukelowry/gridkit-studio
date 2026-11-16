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
})
