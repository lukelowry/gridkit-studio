/** The Case panel: its place in the panel, its type picker, mapping a column onto the network from
 *  its menu, and edits through the document. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame, Locator } from 'playwright-core'
import * as vscode from 'vscode'

import { frames, type TestHost, testHost, until, visible } from './harness.js'

suite('Case', () => {
  let bench: TestHost
  let view: Frame
  /** The header of the Bus column `field`. */
  const header = (field: string): Locator =>
    view.locator(`thead th[data-vscode-context*='"field":"${field}"']`)
  /** Choose `item` from the native menu of `target`. */
  async function menu(target: Locator, item: string) {
    await bench.menu(() => target.click({ button: 'right' }), item)
  }

  suiteSetup(async () => {
    bench = await testHost()
    view = await bench.show('case')
    await visible(view, 'tbody .cell')
  })

  test('sits in the bottom panel, each row known by its own id under one header row', async () => {
    assert.equal(await view.locator('.toolbar').count(), 0)
    const panel = await bench.page.locator('.part.panel').boundingBox()
    const cell = await view.locator('tbody .cell').first().boundingBox()
    assert.ok(panel && cell && cell.y >= panel.y, 'Case must be in the native bottom panel')
    // The row's own id, without its type; the fields by name alone, with no record key above them.
    assert.equal(
      (await view.locator('tbody th[scope="row"]').first().innerText()).trim(),
      String(bench.source.buses[0]!.number),
    )
    assert.equal(await view.locator('thead th', { hasText: /^Element$/ }).count(), 0)
    assert.equal(await view.locator('thead tr').count(), 1)
    await visible(view, `thead th[data-vscode-context*='"field":"init.Vr"']`)
    await bench.capture('case-vscode')
  })

  test('switches type from its title bar, which says what shows', async () => {
    const choose = async (type: RegExp) => {
      await bench.panelAction('Choose Type').click()
      await bench.page.locator('.quick-input-widget .monaco-list-row', { hasText: type }).click()
    }
    await choose(/^GENROU/i)
    await until(
      async () => /genrou/i.test(await view.locator('tbody th[scope="row"]').first().innerText()),
      'generators listed',
    )
    await choose(/^Bus/)
    await visible(view, `thead th[data-vscode-context*='"field":"params.kv"']`)
    // The unit kv already says goes unsaid.
    assert.equal((await header('params.kv').innerText()).trim(), 'kv')
  })

  test('maps a column onto the network from its menu, and removes it there', async () => {
    const network = await bench.view('network')
    const before = await frames(network)
    await menu(header('params.kv'), 'Map To')
    const picker = bench.page.locator('.quick-input-widget')
    await picker.locator('.monaco-list-row', { hasText: 'Vertex Color' }).click()
    await picker.getByRole('button', { name: 'OK' }).click()
    await picker.waitFor({ state: 'hidden' })
    await until(
      () => bench.session.bindings.vertexColor?.field === 'params.kv',
      'the column mapped',
    )
    await until(async () => (await frames(network)) > before, 'the network repaints')
    await until(
      async () => /color/.test(await header('params.kv').innerText()),
      'the header says so',
    )
    await bench.capture('case-mapped')
    await menu(header('params.kv'), 'Mapping Range')
    await picker.locator('input').fill('0.5, 2')
    await picker.locator('input').press('Enter')
    await picker.waitFor({ state: 'hidden' })
    await until(
      () => bench.session.bindings.vertexColor?.domain?.join() === '0.5,2',
      'the range set',
    )
    await menu(header('params.kv'), 'Remove Mapping')
    await until(() => !bench.session.bindings.vertexColor, 'the mapping removed')
    await until(
      async () => !/color/.test(await header('params.kv').innerText()),
      'the header says so',
    )
  })

  test('edits a field through the document, with native undo and redo', async () => {
    const { document, text } = bench
    const kv = bench.source.buses[0]!.params.kv + 1
    // From the cell's keyboard, through the worker, to a WorkspaceEdit.
    await view.locator('td[data-vscode-context*="kv"] .cell').first().dblclick()
    await visible(view, 'input[aria-label="Edit kv"]')
    await view.locator('input[aria-label="Edit kv"]').fill(String(kv))
    await view.locator('input[aria-label="Edit kv"]').press('Enter')
    await until(
      () => document.isDirty && JSON.parse(document.getText()).buses[0].params.kv === kv,
      'the edit reaches the document',
    )
    await bench.settled()
    await bench.undo('native undo')
    await vscode.commands.executeCommand('redo')
    await until(() => document.getText() !== text, 'native redo')
    await bench.settled()
    await bench.undo('the source restored')
  })

  test('offers a field its commands in the native context menu', async () => {
    await bench.opened(
      () =>
        view
          .locator(`td[data-vscode-context*='"field":"params.kv"'] .cell`)
          .first()
          .click({ button: 'right' }),
      'Edit Field',
    )
    await bench.offered('Map To')
    await bench.capture('case-native-menu')
    await bench.page.keyboard.press('Escape')
  })

  test('refuses an edit made against an older revision', async () => {
    const { version } = await bench.current()
    await assert.rejects(
      bench.studio.documents.edit(
        bench.key,
        version - 1,
        { id: 'Bus/' + bench.source.buses[0]!.number, field: 'params.kv' },
        1,
      ),
      /changed/,
    )
  })

  test('follows the active case, and only its rows reach the panel', async () => {
    const { uri } = await bench.openCase('cases/TwoArea.case.json')
    // Back to the first case while the panel may still be loading the second.
    await vscode.commands.executeCommand('gridkitStudio.openCasePanel', uri)
    await vscode.commands.executeCommand('gridkitStudio.openCasePanel', bench.uri)
    // Each case the panel takes up loads a page of its own, so the page is found again each look.
    const rows = String(bench.source.buses.length + 1)
    await until(async () => {
      view = await bench.view('case')
      return (
        (await view
          .locator('table')
          .getAttribute('aria-rowcount')
          .catch(() => null)) === rows
      )
    }, "the panel shows the first case's buses alone")
    await bench.capture('case-switched')
    // The next suite starts from the first case alone, its panels on it.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })
})
