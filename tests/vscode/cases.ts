/** Open every bundled case in a real native webview, including ACTIVSg70k. */
import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { testHost, until } from './harness.js'

export async function run(): Promise<void> {
  const bench = await testHost()
  const reports: unknown[] = []
  try {
    const directory = join(process.env.GRIDKIT_TEST_ROOT!, 'cases')
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.case.json'))) {
      const start = performance.now()
      const { uri, network } = await bench.openCase(join(directory, name))
      await until(
        () => network.evaluate<boolean>('gridkitStats().complete && gridkitStats().frames > 0'),
        `${name} has a complete native frame`,
        120_000,
      )
      const native = await network.evaluate<{ rows: number; frames: number; resident: number }>(
        'gridkitStats()',
      )
      const buses = bench.studio.state(uri.toString()).summary!.counts.Bus!
      assert.ok(buses > 0)
      assert.ok(native.rows >= buses, `${name}: all buses must enter the native scene`)
      assert.deepEqual(bench.studio.reporter.errors, [])
      const report = { name, buses, elapsedMs: performance.now() - start, native }
      reports.push(report)
      console.log('Native case:', JSON.stringify(report))
      if (name.startsWith('ACTIVSg70k')) await bench.capture('native-70k')
    }
    await writeFile(
      join(process.env.GRIDKIT_TEST_OUTPUT!, 'tests/native-cases.json'),
      JSON.stringify(reports, null, 2),
    )
  } finally {
    await bench.finish()
  }
}
