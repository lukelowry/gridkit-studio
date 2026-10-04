import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'

import { pause, type TestHost, testHost, until, visible, VM } from './harness.js'

suite('Network', () => {
  let bench: TestHost
  let network: Frame
  const drawn = () => network.evaluate<number>('gridkitStats().frames')

  suiteSetup(async () => {
    bench = await testHost()
    network = await bench.open('network')
  })

  test('draws the case, filling its editor', async () => {
    assert.equal(bench.studio.state(bench.key).summary?.counts.Bus, 39)
    assert.equal(await network.locator('.status').count(), 0)
    const edges = await network.evaluate<number[]>(`(() => {
  const r = document.querySelector('canvas').getBoundingClientRect()
  return [r.x, r.y, r.width - innerWidth, r.height - innerHeight]
})()`)
    assert.ok(
      edges.every((edge) => Math.abs(edge) < 1),
      'Network must fill its editor',
    )
    bench.report.network = await network.evaluate('gridkitStats()')
    await bench.capture('network-vscode')
  })

  test('carries its own controls: three projections, rotation and fit', async () => {
    await visible(network, '[data-testid="view-toolbar"]')
    assert.equal(await network.locator('.toolbar button').count(), 5)
    await until(
      async () => (await network.locator('.toolbar button[aria-pressed="true"]').count()) === 1,
      'the projection on show is pressed',
    )
  })

  test('clearing the canvas selection clears the shared selection', async () => {
    const frames = await drawn()
    bench.studio.select(bench.key, { id: 'Bus/' + bench.source.buses[0]!.number })
    await until(async () => (await drawn()) > frames, 'the selected bus is drawn')
    await network.locator('canvas').focus()
    await network.locator('canvas').press('Escape')
    await until(() => bench.session.selection === undefined, 'selection cleared across the case')
    assert.equal(bench.studio.state(bench.key).selection, undefined)
  })

  test('keeps its webview while another editor hides it', async () => {
    // Marked, so that the view shown again can be told from one built again.
    await network.evaluate('window.gridkitKept = true')
    await bench.open('diagram')
    network = await bench.open('network')
    assert.equal(await network.evaluate('window.gridkitKept'), true)
  })

  test('paints a mapped signal at the playhead every view shares', async () => {
    await bench.results()
    const { transport } = bench.session
    bench.studio.bind(bench.key, VM, ['vertexColor'])
    transport.setLoop('wrap')
    transport.seek(0)
    const still = await drawn()
    transport.play()
    // Frame after frame while the clock plays, with no word from the extension.
    await until(async () => (await drawn()) > still + 10, 'the network paints the playhead')
    transport.pause()
    assert.equal(await network.locator('.canvas-host__fault:not([hidden])').count(), 0)
    await bench.capture('network-mapped-signal')
  })

  test('draws nothing while hidden, though the clock plays on', async () => {
    const { transport } = bench.session
    await bench.open('diagram')
    await pause(300)
    const hidden = await drawn()
    transport.play()
    await pause(500)
    assert.equal(transport.state.status, 'playing')
    assert.equal(await drawn(), hidden)
    transport.pause()
  })
})
