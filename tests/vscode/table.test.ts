/** The Case table: its place in the panel, its native menu, and edits through the document. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { type TestHost, testHost, until, visible } from './harness.js'

suite('Case table', () => {
  let bench: TestHost
  let table: Frame

  suiteSetup(async () => {
    bench = await testHost()
    table = await bench.show('table')
    await visible(table, 'tbody .cell')
  })

  test('sits in the bottom panel, with no toolbar of its own', async () => {
    assert.equal(await table.locator('.toolbar').count(), 0)
    const panel = await bench.page.locator('.part.panel').boundingBox()
    const cell = await table.locator('tbody .cell').first().boundingBox()
    assert.ok(panel && cell && cell.y >= panel.y, 'Case table must be in the native bottom panel')
    await bench.capture('table-vscode')
  })

  test('offers a field its commands in the native context menu', async () => {
    await table
      .locator('td[data-vscode-context*="gridkitEditable\\\":true"] .cell')
      .first()
      .click({ button: 'right' })
    await bench.offered('Edit Field')
    await bench.capture('table-native-menu')
    await bench.page.keyboard.press('Escape')
  })

  test('edits a field through the document, with native undo and redo', async () => {
    const { document, text } = bench
    const kv = bench.source.buses[0]!.params.kv + 1
    // From the cell's keyboard, through the worker, to a WorkspaceEdit.
    await table.locator('td[data-vscode-context*="kv"] .cell').first().dblclick()
    await visible(table, 'input[aria-label="Edit kv"]')
    await table.locator('input[aria-label="Edit kv"]').fill(String(kv))
    await table.locator('input[aria-label="Edit kv"]').press('Enter')
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

  test('refuses an edit made against an older revision', async () => {
    const { version } = await bench.current()
    await assert.rejects(
      bench.studio.documents.edit(
        bench.key,
        version - 1,
        { id: 'Bus/' + bench.source.buses[0]!.number, field: 'kv' },
        1,
      ),
      /changed/,
    )
  })
})
