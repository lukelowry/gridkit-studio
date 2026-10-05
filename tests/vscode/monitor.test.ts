/** The Monitor: plotting in the bottom panel, the case's one clock, and its native menu. */

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

  test('plots the chosen signal in the bottom panel', async () => {
    await visible(monitor, '[data-testid="transport"]')
    await visible(monitor, '[data-testid="monitor-signal"]')
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
      async () =>
        (await monitor.locator('[data-testid="transport-time"]').textContent())?.includes('0.50'),
      'the playhead reaches the view',
    )
  })

  test('changes that clock from its own controls', async () => {
    await monitor.locator('[data-testid="transport-play"]').click()
    await until(() => transport().state.status === 'playing', 'playback from the view')
    await vscode.commands.executeCommand('gridkitStudio.toggleTimeline')
    assert.equal(transport().state.status, 'paused')
    await monitor.locator('[data-testid="transport-loop"]').click()
    await until(() => transport().state.loop === 'wrap', 'repeat from the view')
    const paused = transport().currentT()
    await monitor.locator('[data-testid="transport-step-forward"]').click()
    await until(() => transport().currentT() > paused, 'a frame step from the view')
  })

  test('opens its settings from the native context menu', async () => {
    await monitor.locator('canvas').click({ button: 'right' })
    await bench.offered('Monitor Settings')
    await bench.capture('monitor-native-menu')
    await bench.page.keyboard.press('Escape')
  })

  test('keeps its plots while another panel takes its place', async () => {
    await visible(await bench.show('table'), 'tbody .cell')
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })
})
