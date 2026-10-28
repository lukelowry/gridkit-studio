/** Real GridKit output, native ID joins, whole-run domains, and rendered time changes. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { type TestHost, testHost, until } from './harness.js'

suite('WECC240 run', function () {
  this.timeout(600_000)
  this.bail(true)
  let bench: TestHost
  let network: Frame
  let uri: vscode.Uri
  let ids: number[]
  const session = () => bench.studio.get(uri.toString())!
  const settings = () => vscode.workspace.getConfiguration('gridkitStudio', uri)
  suiteSetup(async function () {
    bench = await testHost()
    if (!(await bench.gridkit())) this.skip()
    ;({ uri, network } = await bench.openCase('cases/WECC240.case.json'))
    ids = JSON.parse(await readFile(uri.fsPath, 'utf8')).buses.map(
      (bus: { number: number }) => bus.number,
    )
    for (const [key, value] of Object.entries({
      'network.tilt': 45,
      'network.labels': false,
      'network.ease': 0,
      'network.map.source': 'none',
    }))
      await settings().update(key, value, vscode.ConfigurationTarget.Global)
  })
  suiteTeardown(async () => {
    if (!uri) return
    for (const key of ['network.tilt', 'network.labels', 'network.ease', 'network.map.source'])
      await settings().update(key, undefined, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })
  test('records only Va and joins every native bus ID to the rendered source', async () => {
    await vscode.commands.executeCommand('gridkitStudio.recordNoSignals')
    await until(
      () => !Object.keys(bench.studio.state(uri.toString()).summary?.recording.listed ?? {}).length,
      'recording cleared',
    )
    await bench.record('Bus', ['Va'], uri)
    session().bind({ table: 'Bus', field: 'Va' }, ['vertexColor', 'vertexHeight'])
    bench.run(
      'Run Dynamic Simulation',
      await bench.writeSolver(
        {
          tmax: 1,
          dt_monitor: 0.01,
          events: [
            { time: 0.1, type: 'fault_on', element_id: 0 },
            { time: 0.15, type: 'fault_off', element_id: 0 },
          ],
        },
        uri,
      ),
    )
    await until(
      () => session().run?.state === 'complete' || session().run?.state === 'failed',
      'WECC240 simulation finishes',
      300_000,
    )
    assert.equal(session().run!.state, 'complete', session().run!.message)
    const results = session().results!
    assert.deepEqual(
      results.outputs.map((output) => [output.table, output.field]),
      [['Bus', 'Va']],
    )
    assert.deepEqual(new Set(results.outputs[0]!.ids), new Set(ids))
    assert.ok(Math.abs(results.domain[1] - 1) < 1e-9)
    const domain = [...results.domains!.Bus!.Va!]
    const images: Buffer[] = []
    const values: number[] = []
    for (const at of [0, 0.6, 0]) {
      session().transport.seek(at)
      await until(
        () =>
          network.evaluate<boolean>(
            `gridkitStats().covered && gridkitStats().complete && Math.abs(gridkitStats().at - ${at}) < 1e-8`,
          ),
        'native mapped time is complete',
      )
      const exact = await bench.studio.client.results.call('sample', {
        results: results.id,
        table: 'Bus',
        field: 'Va',
        id: ids[0]!,
        at,
      })
      assert.ok(exact && exact.value !== null)
      values.push(exact.value)
      images.push(await network.locator('canvas').screenshot())
      assert.deepEqual(
        session().results!.domains!.Bus!.Va!,
        domain,
        'Scrubbing preserves the whole-run domain',
      )
    }
    assert.notEqual(values[0], values[1], 'The fault changes the authoritative angle')
    assert.equal(values[0], values[2], 'Exact inspection is repeatable')
    assert.notDeepEqual(images[0], images[1], 'Native sampled bindings repaint the network')
    const points = await network.evaluate<(number[] | null)[]>(
      `Promise.all(${JSON.stringify(ids)}.map(id => gridkitLocate({table:'Bus', id})))`,
    )
    assert.ok(
      points.filter(Boolean).length >= ids.length * 0.8,
      'Native ID lookup locates the buses',
    )
    assert.deepEqual(bench.studio.reporter.errors, [])
    await bench.capture('run-wecc240-native')
  })
})
