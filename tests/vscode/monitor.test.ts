/** The Monitor: plotting in the bottom panel, the case's one clock played from the status bar,
 *  and its native menu. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { type TestHost, testHost, until, visible } from './harness.js'

suite('Monitor', () => {
  let bench: TestHost
  let monitor: Frame
  const transport = () => bench.session.transport

  suiteSetup(async () => {
    bench = await testHost()
    await bench.results()
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('plots the chosen signal in the bottom panel, played from the status bar', async () => {
    await bench.playback('Play').waitFor()
    await bench.panelAction('Add Plot').waitFor()
    assert.match((await monitor.locator('.lane__name').first().textContent()) ?? '', /Bus · /)
    const panel = await bench.page.locator('.part.panel').boundingBox()
    const plot = await monitor.locator('canvas').boundingBox()
    assert.ok(panel && plot && plot.y >= panel.y, 'Monitor must be in the bottom panel')
    await bench.capture('monitor-vscode')
  })

  test("follows the case's one clock when a command moves it", async () => {
    assert.equal(transport().state.status, 'paused')
    await vscode.commands.executeCommand('gridkitStudio.seekTime', 0.5)
    assert.equal(transport().currentT(), 0.5)
    await until(
      async () => (await bench.playback('Time').innerText()).includes('0.50'),
      'the status bar reads the playhead',
    )
  })

  test('changes that clock from the status bar', async () => {
    await bench.playback('Play').click()
    await until(() => transport().state.status === 'playing', 'playback from the status bar')
    await vscode.commands.executeCommand('gridkitStudio.toggleTimeline')
    assert.equal(transport().state.status, 'paused')
    const paused = transport().currentT()
    await bench.playback('Next sample').click()
    await until(() => transport().currentT() > paused, 'a frame step from the status bar')
    await bench.playback('Speed').click()
    await bench.page.locator('.quick-input-widget .monaco-list-row', { hasText: /^2$/ }).click()
    await until(() => transport().state.rate === 2, 'a faster speed')
    await until(
      async () => (await bench.playback('Speed').innerText()).includes('2×'),
      'it says so',
    )
    await bench.playback('Go to end').click()
    await until(() => transport().currentT() === transport().state.span[1], 'the run ends')
  })

  test('opens its settings from the native context menu', async () => {
    await monitor.locator('canvas').click({ button: 'right' })
    await bench.offered('Monitor Settings')
    await bench.capture('monitor-native-menu')
    await bench.page.keyboard.press('Escape')
  })

  test('keeps its plots while another panel takes its place', async () => {
    await visible(await bench.show('case'), 'tbody .cell')
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })
})
