import assert from 'node:assert/strict'

import { failed, finish, stats, testHost, visible } from './harness.js'
export async function run(): Promise<void> {
  try {
    const bench = await testHost()
    const network = await bench.open('network')
    console.log('Native network:', await stats(network))
    const table = await bench.show('case')
    await visible(table, 'tbody .cell')
    console.log('Native table rows:', await table.locator('tbody tr').count())
    await bench.results()
    const monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    console.log('Native monitor:', await monitor.evaluate('gridkitMonitor()'))
    const diagram = await bench.open('diagram')
    console.log('Native diagram:', await stats(diagram))
    assert.deepEqual(bench.studio.reporter.errors, [])
    await bench.capture('native-smoke')
  } catch (error) {
    await failed('native-smoke')
    throw error
  } finally {
    await finish()
  }
}
