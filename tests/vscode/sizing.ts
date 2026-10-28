/** Visual checks for one general sizing rule across sparse and dense native networks. */
import assert from 'node:assert/strict'

import * as vscode from 'vscode'

import { testHost, until } from './harness.js'

export async function run(): Promise<void> {
  const bench = await testHost()
  const settings = vscode.workspace.getConfiguration('gridkitStudio')
  try {
    for (const name of ['IEEE39', 'WECC240', 'ACTIVSg70k']) {
      const { network } = await bench.openCase(`cases/${name}.case.json`)
      await until(() => network.evaluate<boolean>('gridkitStats().complete'), `${name} settled`)
      await bench.capture(`native-sizing-${name}`)
      if (name !== 'ACTIVSg70k') continue
      const before = await network.locator('canvas').screenshot()
      const camera = await network.evaluate('gridkitSelection().camera')
      const received = await network.evaluate<number>('gridkitStats().received')
      const frames = await network.evaluate<number>('gridkitStats().frames')
      await settings.update('network.vertexRadius', 5, vscode.ConfigurationTarget.Global)
      await settings.update('network.edgeWidth', 1.5, vscode.ConfigurationTarget.Global)
      await until(
        () =>
          network.evaluate<boolean>(`gridkitStats().frames > ${frames} && gridkitStats().complete`),
        'native mark sizes update',
      )
      assert.notDeepEqual(await network.locator('canvas').screenshot(), before)
      assert.deepEqual(await network.evaluate('gridkitSelection().camera'), camera)
      assert.equal(await network.evaluate('gridkitStats().received'), received)
      await bench.capture('native-sizing-70k-larger')
    }
    assert.deepEqual(bench.studio.reporter.errors, [])
    console.log('Sparse/dense native sizing and live controls passed.')
  } finally {
    for (const key of ['network.vertexRadius', 'network.edgeWidth'])
      await settings.update(key, undefined, vscode.ConfigurationTarget.Global)
    await bench.finish()
  }
}
