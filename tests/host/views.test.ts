/** Which case the views follow, an editor that closes as its case changes, and the keys that place
 *  Studio's commands in VS Code. Drawing is the end-to-end journeys' to check. */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { setup, suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { named } from '../menus.js'
import { type Bench, bench, folder, until } from './studio.js'

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
    await vscode.commands.executeCommand('vscode.openWith', host.uri, 'gridkitStudio.diagram')
    await until(() => host.studio.active === host.key, 'IEEE39 followed')
    await vscode.commands.executeCommand('gridkitStudio.openCasePanel', other)
    await until(() => host.studio.active === other.toString(), 'the case the command names')
    assert.equal(host.studio.state(other.toString()).summary?.name, 'TwoArea')
  })

  test('keep to the case a command chose while VS Code opens a tab behind the canvas in front', async () => {
    const copy = vscode.Uri.joinPath(folder(), `behind-${randomUUID()}.case.json`)
    await vscode.workspace.fs.copy(host.uri, copy)
    await vscode.commands.executeCommand('vscode.openWith', host.uri, 'gridkitStudio.network')
    await vscode.commands.executeCommand('gridkitStudio.openCasePanel', copy)
    await until(() => host.studio.documents.get(copy.toString())?.summary, 'the copy read')
    const tab = () =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some(
          ({ input }) =>
            input instanceof vscode.TabInputCustom && input.uri.toString() === copy.toString(),
        )
    try {
      // An edit leaves the copy unsaved, and VS Code opens a canvas of its own for it, behind the
      // one in front. The views stay with the copy.
      await host.record('Bus', ['Vm'], copy)
      await until(tab, 'a tab for the unsaved copy')
      assert.equal(host.studio.active, copy.toString())
    } finally {
      await (await vscode.workspace.openTextDocument(copy)).save()
    }
  })

  test('say nothing when an editor closes as its case changes', async () => {
    // VS Code closes an editor before the extension host hears so: a change made meanwhile still
    // updates its view, which must not ask the panel gone by then whether it shows. The close and
    // the change race, so they are tried at a few offsets, many times.
    for (let cycle = 0; cycle < 30; cycle++) {
      await vscode.commands.executeCommand('vscode.openWith', host.uri, 'gridkitStudio.network')
      const closing = vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await new Promise((resolve) => setTimeout(resolve, cycle % 4))
      host.studio
        .get(host.key)
        ?.bind({ table: 'Bus', field: 'init.Vr' }, cycle % 2 ? ['vertexColor'] : [])
      await closing
    }
    assert.deepEqual(host.said(), [])
  })

  test('place commands only by context keys Studio or VS Code sets', () => {
    // A view's menu takes the keys its page gives the click, which the manifest's unit test checks.
    const known = new Set([
      ...Object.keys(host.keys()),
      'view',
      'viewItem',
      'activeCustomEditorId',
      'resourceFilename',
    ])
    for (const { place, when } of host.menus.clauses())
      if (place !== 'webview/context')
        for (const key of named(when)) assert.ok(known.has(key), `${key}, in ${place}: ${when}`)
  })
})
