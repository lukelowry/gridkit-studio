import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import * as vscode from 'vscode'

import { type TestHost, testHost, visible } from './harness.js'

suite('Export', () => {
  let bench: TestHost
  // The simple dialog is one the test can type a path into.
  const simpleDialog = (on: true | undefined) =>
    vscode.workspace
      .getConfiguration()
      .update('files.simpleDialog.enable', on, vscode.ConfigurationTarget.Global)

  suiteSetup(async () => {
    bench = await testHost()
    await bench.results()
    await simpleDialog(true)
  })
  suiteTeardown(() => simpleDialog(undefined))

  test('writes a video of the run to the file its reader picks', async () => {
    const video = vscode.Uri.joinPath(bench.uri, '..', 'two bus.webm')
    const exporter = await bench.show('export')
    await visible(exporter, '[data-testid="video-export"]')
    await exporter.getByRole('switch', { name: 'Monitor' }).click()
    await exporter.locator('[data-testid="video-format"]').click()
    await exporter.locator('[role="option"][data-value="webm"]').click()
    await exporter.locator('[data-testid="video-resolution"]').click()
    await exporter.locator('[role="option"][data-value="720"]').click()
    await exporter.locator('[data-testid="video-start"]').click()
    const dialog = bench.page.locator('.quick-input-widget input')
    await dialog.waitFor({ state: 'visible' })
    await dialog.fill(video.fsPath)
    await dialog.press('Enter')
    await exporter.locator('[data-testid="video-done"]').waitFor({ timeout: 120000 })
    const { size } = await stat(video.fsPath)
    assert.ok(size > 1000, 'The exported video has frames')
    bench.report.videoBytes = size
    await bench.capture('export-vscode')
  }).timeout(180_000)
})
