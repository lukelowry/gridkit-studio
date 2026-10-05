/** WECC240 end to end: a native run records voltage angle alone, which drives the tilted
 *  network's vertex color and height as frames arrive and as the finished run is scrubbed. */
import assert from 'node:assert/strict'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import pixelmatch from 'pixelmatch'
import type { Frame } from 'playwright-core'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import { dynamicSimulation } from '../../src/gridkit/runtime.js'
import { recordedWhole } from '../../src/shared/bindings.js'
import { type TestHost, testHost, until } from './harness.js'

const VA = { type: 'Bus', field: 'Va' } as const

suite('WECC240 run', function () {
  // A run of the whole case takes what GridKit takes.
  this.timeout(600_000)
  this.bail(true)
  let bench: TestHost
  let network: Frame
  let uri: vscode.Uri
  const session = () => bench.studio.all.get(uri.toString())!
  const painted = () => network.evaluate<number>('gridkitStats().frames')
  /** The network at `t`, once it has painted there. */
  async function at(t: number): Promise<PNG> {
    const before = await painted()
    session().transport.seek(t)
    await until(async () => (await painted()) > before, `the network paints t = ${t}`)
    return PNG.sync.read(await network.locator('canvas').screenshot())
  }

  suiteSetup(async function () {
    bench = await testHost()
    // GridKit runs where it is installed, such as the dev container; elsewhere the suite is skipped.
    const install = vscode.workspace.getConfiguration('gridkitStudio').get('gridkitPath', '')
    if (process.env.GRIDKIT_TEST_REQUIRED === '1') await dynamicSimulation(install)
    else if (!(await dynamicSimulation(install).catch(() => undefined))) this.skip()
    ;({ uri, network } = await bench.openCase('cases/WECC240.case.json'))
  })
  suiteTeardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'))

  test('runs with Va alone, mapped to color and height on a tilted network', async () => {
    const key = uri.toString()
    for (const { from } of session().outputs ?? []) bench.studio.record(key, from, [])
    bench.studio.record(key, 'Bus', ['Va'])
    bench.studio.bind(key, VA, ['vertexColor', 'vertexHeight'])
    await network.getByRole('button', { name: 'Tilt', exact: true }).click()
    await until(() => {
      const camera = session().cameras.network as { projection?: string; pitch?: number }
      return camera?.projection === 'tilt' && (camera.pitch ?? 0) > 0
    }, 'the network tilts')
    // A fault at JOHN DAY 500 kV, the case's own fault bus, cleared after 50 ms, swings the angles.
    session().values = {
      tmax: 1,
      dt_monitor: 0.01,
      fault: true,
      fault_bus: 'Bus/4005',
      fault_start: 0.1,
      fault_duration: 0.05,
    }
    const before = await painted()
    await vscode.commands.executeCommand('gridkitStudio.run', uri)
    await until(() => (session().run?.frames ?? 0) > 0, 'frames arrive', 180_000)
    await until(async () => (await painted()) > before, 'live Va frames repaint the network')
    await until(() => session().run?.state !== 'running', 'the run ends', 300_000)
    const run = session().run!
    assert.equal(run.state, 'complete', run.message)
    assert.deepEqual(
      run.outputs.map(({ from, select }) => [from, select]),
      [['Bus', ['Va']]],
    )
    const buses = bench.studio.state(uri.toString()).summary!.counts.Bus!
    assert.ok(recordedWhole(run.outputs, buses, VA), 'a binding draws every bus')
    assert.ok(Math.abs(run.domain[1] - 1) < 1e-9, `the run ends at ${run.domain[1]}`)
    assert.equal(await network.locator('.canvas-host__fault:not([hidden])').count(), 0)
  })

  test('angle swings after the fault restyle the colors and heights Va drives', async () => {
    const rest = await at(0)
    const swung = await at(0.5)
    const changed = pixelmatch(rest.data, swung.data, undefined, rest.width, rest.height, {
      threshold: 0.1,
    })
    assert.ok(changed > rest.width * rest.height * 0.002, `only ${changed} pixels changed`)
    bench.report.wecc240 = {
      frames: session().run!.frames,
      stats: await network.evaluate('gridkitStats()'),
    }
    await bench.capture('run-wecc240-tilt')
  })
})
