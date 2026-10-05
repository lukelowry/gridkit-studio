import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import { gridkitOf } from '../../src/extension/tasks.js'
import { runtimeOf } from '../../src/gridkit/runtime.js'
import { colored, type TestHost, testHost, until, visible, VM } from './harness.js'

suite('Run', function () {
  // A run of the whole case takes what GridKit takes.
  this.timeout(600_000)
  this.bail(true)
  let bench: TestHost
  let network: Frame
  let monitor: Frame
  let simulation: Frame
  let end = 0
  const painted = () => network.evaluate<number>('gridkitStats().frames')

  suiteSetup(async function () {
    bench = await testHost()
    // GridKit runs where it is installed, such as the dev container, or in GRIDKIT_IMAGE; without
    // either the suite is skipped.
    const gridkit = gridkitOf(bench.uri)
    if (process.env.GRIDKIT_TEST_REQUIRED === '1') await runtimeOf(gridkit)
    else if (!(await runtimeOf(gridkit).catch(() => undefined))) this.skip()
    network = await bench.open('network')
  })

  test('chooses signals from the empty Monitor and runs without seeded plots', async () => {
    assert.deepEqual(bench.session.plots, [])
    monitor = await bench.show('monitor')
    // The Monitor's own button brings the native Monitored Signals view back into sight.
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    await monitor.getByRole('button', { name: 'Choose monitored signals' }).click()
    const signals = bench.page.locator('.pane', {
      has: bench.page.locator('.pane-header', { hasText: /monitored signals/i }),
    })
    await signals.getByRole('treeitem').first().waitFor({ state: 'visible', timeout: 30000 })
    // Clear every signal through the view's own title action.
    await signals.locator('.pane-header').hover()
    await signals.getByRole('button', { name: 'Record No Signals' }).click()
    await until(() => !bench.session.outputs?.length, 'all monitored fields cleared')
    simulation = await bench.view('simulation')
    await until(
      async () => await simulation.locator('[data-testid="study-run"]').isDisabled(),
      'empty selection disables Run in the view',
    )
    await bench.toggleSignal('Bus', 'Vm')
    await until(() => bench.session.outputs?.length === 1, 'one selected field')
    // The form has heard of the selection, and of the values it had, before any is typed.
    await until(
      async () => !(await simulation.locator('[data-testid="study-run"]').isDisabled()),
      'the view hears of the selection',
    )
    await simulation.locator('[data-testid="field-tmax"]').fill('2')
    await simulation.locator('[data-testid="field-dt_monitor"]').fill('0.01')
    await until(() => bench.session.values.tmax === 2, 'run settings captured')
    await vscode.commands.executeCommand('workbench.action.closePanel')
    const { session } = bench
    const shown = session.run?.id
    const before = await painted()
    await simulation.locator('[data-testid="study-run"]').click()
    // No show('monitor') call: Run itself must reveal the panel.
    monitor = await bench.view('monitor')
    await until(
      () => session.run && session.run.id !== shown && session.run.frames > 0,
      'frames arrive',
      180000,
    )
    const followed = session.run!.state !== 'running' || session.transport.state.follow
    await until(() => session.run?.state !== 'running', 'the run ends', 300000)
    assert.equal(session.run?.state, 'complete', session.run?.message)
    assert.equal(session.run.frames, 201)
    assert.deepEqual(session.plots, [{ from: 'Bus', field: 'Vm' }])
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
    await monitor.locator('canvas').focus()
    await until(
      async () => /1\.0485/.test(await monitor.locator('.lane [role="status"]').innerText()),
      'the plotted trace reads a native voltage',
    )
    assert.ok(followed, 'The playhead follows a run as it arrives')
    const plot = PNG.sync.read(await monitor.locator('canvas').screenshot())
    assert.ok(
      colored(plot) > plot.width,
      'Native traces must be painted, not just axes and a playhead',
    )
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
    bench.studio.bind(bench.key, VM, ['vertexColor', 'vertexHeight'])
    const rested = await painted()
    bench.session.transport.seek(end / 2)
    await until(async () => (await painted()) > rested, 'a seek repaints the network')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
    assert.equal(await network.locator('.canvas-host__fault:not([hidden])').count(), 0)
    await bench.capture('run-vscode')
  })

  test('steps, replays and pauses native results from the Monitor controls', async () => {
    const t = bench.session.transport.currentT()
    await monitor.locator('[data-testid="transport-step-forward"]').click()
    await until(() => bench.session.transport.currentT() > t, 'step one recorded sample')
    await vscode.commands.executeCommand('gridkitStudio.seekTime', end)
    await until(
      async () =>
        (await monitor.locator('[data-testid="transport-play"]').getAttribute('aria-label')) ===
        'Replay',
      'replay offered at end',
    )
    await monitor.locator('[data-testid="transport-play"]').click()
    await until(() => bench.session.transport.state.status === 'playing', 'replay starts')
    await monitor.locator('[data-testid="transport-play"]').click()
    await until(() => bench.session.transport.state.status === 'paused', 'pause from Monitor')
  })

  test('keeps existing plots when the next run selects different fields', async () => {
    const previous = bench.session.run!.id
    simulation = await bench.show('simulation')
    await bench.toggleSignal('Bus', 'Va')
    await bench.toggleSignal('Bus', 'Vm')
    await until(
      () => bench.session.outputs?.[0]?.select.join() === 'Va',
      'next run records only angle',
    )
    assert.deepEqual(bench.session.plots, [{ from: 'Bus', field: 'Vm' }])
    assert.equal(bench.session.run!.outputs[0]!.select[0], 'Vm')
    await simulation.locator('[data-testid="study-run"]').click()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state === 'complete',
      'second run completes',
    )
    assert.equal(bench.session.previous?.id, previous)
    assert.deepEqual(bench.session.plots, [{ from: 'Bus', field: 'Va' }])
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('runs TwoArea with its native Ispdlim values and plots the result', async () => {
    const text = await readFile(
      join(process.env.GRIDKIT_TEST_ROOT!, 'tests/fixtures/TwoArea.case.json'),
      'utf8',
    )
    const edit = new vscode.WorkspaceEdit()
    edit.replace(bench.uri, new vscode.Range(0, 0, bench.document.lineCount, 0), text)
    await vscode.workspace.applyEdit(edit)
    await bench.settled()
    assert.deepEqual((await bench.current()).issues, [])
    const previous = bench.session.run!.id
    simulation = await bench.show('simulation')
    await bench.toggleSignal('Bus', 'Vm')
    await until(
      () => bench.session.outputs?.some((output) => output.select.includes('Vm')),
      'voltage recorded',
    )
    await simulation.locator('[data-testid="study-run"]').click()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state !== 'running',
      'TwoArea ends',
    )
    assert.equal(bench.session.run?.state, 'complete', bench.session.run?.message)
    assert.equal(bench.session.run.frames, 201)
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    await bench.capture('run-twoarea')
  })

  test('follows live samples, stops the native task and keeps partial plots', async () => {
    simulation = await bench.show('simulation')
    await simulation.locator('[data-testid="field-tmax"]').fill('1000')
    await simulation.locator('[data-testid="field-dt_monitor"]').fill('0.001')
    await until(() => bench.session.values.tmax === 1000, 'long run configured')
    const previous = bench.session.run!.id
    await simulation.locator('[data-testid="study-run"]').click()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.frames! > 64,
      'live samples arrive',
    )
    assert.equal(bench.session.run?.state, 'running')
    assert.equal(bench.session.transport.state.follow, true)
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    bench.session.transport.seek(0)
    await visible(monitor, '[data-testid="monitor-go-live"]')
    await monitor.locator('[data-testid="monitor-go-live"]').click()
    await until(() => bench.session.transport.state.follow, 'follow live again')
    await simulation.locator('[data-testid="study-stop"]').click()
    await until(() => bench.session.run?.state === 'cancelled', 'native task cancelled')
    assert.ok(bench.session.run!.frames > 0)
    assert.ok(bench.session.run!.domain[1] < 1000)
    await visible(monitor, 'canvas[data-rendered=true]')
    await monitor.locator('[data-testid="transport-step-back"]').click()
    await until(
      () => bench.session.transport.currentT() < bench.session.run!.domain[1],
      'partial results remain playable',
    )
  })

  test('shows a native failure in Monitor and successfully retries after correction', async () => {
    const good = bench.document.getText()
    const replace = async (text: string) => {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(bench.uri, new vscode.Range(0, 0, bench.document.lineCount, 0), text)
      await vscode.workspace.applyEdit(edit)
      await bench.settled()
    }
    await replace(good.replace(/"Ispdlim":\s*0\.0/, '"Ispdlim":2.0'))
    simulation = await bench.show('simulation')
    await simulation.locator('[data-testid="field-tmax"]').fill('0.1')
    const previous = bench.session.run!.id
    await simulation.locator('[data-testid="study-run"]').click()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state === 'failed',
      'native initialization fails',
    )
    monitor = await bench.view('monitor')
    await until(
      async () => /Ispdlim/.test(await monitor.locator('[role="alert"]').first().innerText()),
      'native error shown in Monitor',
    )
    await replace(good)
    await simulation.locator('[data-testid="study-run"]').click()
    await until(() => bench.session.run?.state === 'complete', 'corrected TwoArea runs')
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
  })
})
