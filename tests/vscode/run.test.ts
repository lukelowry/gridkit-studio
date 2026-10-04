import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { dynamicSimulation } from '../../src/gridkit/runtime.js'
import { type TestHost, testHost, until, visible, VM } from './harness.js'

suite('Run', function () {
  // A run of the whole case takes what GridKit takes.
  this.timeout(600_000)
  let bench: TestHost
  let network: Frame
  let monitor: Frame
  let end = 0
  const painted = () => network.evaluate<number>('gridkitStats().frames')

  suiteSetup(async function () {
    bench = await testHost()
    // GridKit runs where it is installed, such as the dev container; elsewhere the suite is skipped.
    const install = vscode.workspace
      .getConfiguration('gridkitStudio', bench.uri)
      .get('gridkitPath', '')
    if (!(await dynamicSimulation(install).catch(() => undefined))) this.skip()
    network = await bench.open('network')
    bench.plot()
    bench.studio.bind(bench.key, VM, ['vertexColor', 'vertexHeight'])
  })

  test('appends frames to the views as they arrive, the playhead following', async () => {
    const { session } = bench
    const shown = session.run?.id
    const before = await painted()
    await vscode.commands.executeCommand('gridkitStudio.run', bench.uri)
    await until(
      () => session.run && session.run.id !== shown && session.run.frames > 0,
      'frames arrive',
      180000,
    )
    const followed = session.run!.state !== 'running' || session.transport.state.follow
    await until(() => session.run?.state !== 'running', 'the run ends', 300000)
    assert.equal(session.run?.state, 'complete', session.run?.message)
    assert.ok(followed, 'The playhead follows a run as it arrives')
    bench.report.run = {
      frames: session.run!.frames,
      domain: session.run!.domain,
      painted: (await painted()) - before,
    }
  })

  test('rests at the end of the finished run, the Monitor on show again', async () => {
    const { run, transport } = bench.session
    end = run!.domain[1]
    assert.equal(transport.state.follow, false)
    assert.equal(transport.currentT(), end)
    // The task's terminal took the panel while it ran.
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    await until(
      async () =>
        (await monitor.locator('[data-testid="transport-time"]').textContent())
          ?.replace(/\s+/g, ' ')
          .includes(end.toFixed(2) + ' /'),
      'the Monitor rests at the end of the run',
    )
  })

  test('scrubs the finished run from what each view holds', async () => {
    const rested = await painted()
    bench.session.transport.seek(end / 2)
    await until(async () => (await painted()) > rested, 'a seek repaints the network')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
    assert.equal(await network.locator('.canvas-host__fault:not([hidden])').count(), 0)
    await bench.capture('run-vscode')
  })
})
