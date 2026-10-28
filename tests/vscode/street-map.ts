/** Optional online verification, separate from the offline/package suites. */
import assert from 'node:assert/strict'

import * as vscode from 'vscode'

import { testHost, until } from './harness.js'

export async function run(): Promise<void> {
  const bench = await testHost()
  const settings = vscode.workspace.getConfiguration('gridkitStudio')
  try {
    const { network } = await bench.openCase('cases/WECC240.case.json')
    const before = await network.evaluate<{ center: [number, number]; zoom: number }>(
      'gridkitSelection().camera',
    )
    console.log('Cold case camera:', JSON.stringify(before))
    assert.ok(before.zoom > 1, 'the initial fit frames the case, not the whole world')
    assert.ok(before.center[0] < -90 && before.center[0] > -140, 'the case is in western America')
    await settings.update('network.map.source', 'streets', vscode.ConfigurationTarget.Global)
    await until(
      () => network.evaluate<boolean>('gridkitStats()?.tiles > 0 && gridkitStats()?.frames > 0'),
      'native OpenFreeMap vector tiles draw',
      90_000,
    )
    const attribution = network.locator('.canvas-host__status')
    assert.ok(await attribution.isVisible())
    assert.match(await attribution.innerText(), /OpenStreetMap/)
    await until(() => network.evaluate<boolean>('gridkitStats().complete'), 'street map settled')
    assert.deepEqual(await network.evaluate('gridkitSelection().camera'), before)
    assert.deepEqual(bench.studio.reporter.errors, [])
    await bench.capture('native-street-map')
    console.log('Native street maps and attribution passed')
  } finally {
    await settings.update('network.map.source', undefined, vscode.ConfigurationTarget.Global)
    await bench.finish()
  }
}
