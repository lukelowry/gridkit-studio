/** Runs against real GridKit from the views: signals, live samples, playback, a cancelled run,
 *  and a native failure. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import { frames, notifications, type TestHost, testHost, until, visible, VM } from './harness.js'

/** Pixels painted in a color, not the grays of axes, text and background. */
function colored(png: PNG): number {
  let count = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!
    const g = png.data[i + 1]!
    const b = png.data[i + 2]!
    if (Math.max(r, g, b) - Math.min(r, g, b) > 30) count++
  }
  return count
}

suite('Run', function () {
  // A run of the whole case takes as long as GridKit does.
  this.timeout(600_000)
  this.bail(true)
  let bench: TestHost
  let network: Frame
  let monitor: Frame
  let simulation: Frame
  let end = 0

  suiteSetup(async function () {
    bench = await testHost()
    if (!(await bench.gridkit())) this.skip()
    network = await bench.open('network')
  })

  test('chooses signals from the empty Monitor and runs without seeded plots', async () => {
    assert.deepEqual(bench.session.plots, [])
    monitor = await bench.show('monitor')
    // The Monitor's own button brings the native Monitored Signals view back into sight.
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    await monitor.getByRole('button', { name: 'Choose monitored signals' }).click()
    const signals = await bench.signals({ reveal: false })
    // Clear every signal through the view's own title action.
    await signals.locator('.pane-header').hover()
    await signals.getByRole('button', { name: 'Record No Signals' }).click()
    await until(() => !bench.session.outputs?.length, 'all monitored fields cleared')
    simulation = await bench.view('simulation')
    await until(
      () => simulation.locator('[data-testid="simulation-start"]').isDisabled(),
      'empty selection disables Run in the view',
    )
    await bench.toggleSignal('Bus', 'Vm')
    await until(() => bench.session.outputs?.length === 1, 'one selected field')
    // The form hears of the selection, and keeps its values, before any value is typed.
    await until(
      async () => !(await simulation.locator('[data-testid="simulation-start"]').isDisabled()),
      'the view hears of the selection',
    )
    await simulation.locator('[data-testid="field-tmax"]').fill('2')
    await simulation.locator('[data-testid="field-dt_monitor"]').fill('0.01')
    await until(() => bench.session.values.tmax === 2, 'run settings captured')
    await vscode.commands.executeCommand('workbench.action.closePanel')
    const { session } = bench
    const shown = session.run?.id
    const before = await frames(network)
    await simulation.locator('[data-testid="simulation-start"]').click()
    // Run itself reveals the Monitor.
    monitor = await bench.view('monitor')
    await until(
      () => session.run && session.run.id !== shown && session.run.frames > 0,
      'frames arrive',
      180_000,
    )
    const followed = session.run!.state !== 'running' || session.transport.state.follow
    await until(() => session.run?.state !== 'running', 'the run ends', 300_000)
    assert.equal(session.run?.state, 'complete', session.run?.message)
    assert.equal(session.run.frames, 201)
    assert.deepEqual(session.plots, [{ from: 'Bus', field: 'Vm' }])
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
    await monitor.locator('canvas').focus()
    const reading = () => monitor.locator('.lane [role="status"]').innerText()
    await until(
      async () => /1\.0485/.test(await reading()),
      async () => {
        const { status, follow } = bench.session.transport.state
        return `the plotted trace reads a native voltage: it read "${await reading()}", the clock ${status}${follow ? ' and following' : ''}`
      },
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
      painted: (await frames(network)) - before,
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
    const rested = await frames(network)
    bench.session.transport.seek(end / 2)
    await until(async () => (await frames(network)) > rested, 'a seek repaints the network')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
    assert.equal(await network.locator('.canvas-host__notice:not([hidden])').count(), 0)
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
    await simulation.locator('[data-testid="simulation-start"]').click()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state === 'complete',
      'second run completes',
    )
    assert.equal(bench.session.previous?.id, previous)
    assert.deepEqual(bench.session.plots, [{ from: 'Bus', field: 'Va' }])
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('analyzes a fault on every bus, and shows each contingency in place', async () => {
    simulation = await bench.show('simulation')
    await simulation.locator('[data-testid="study-program"]').click()
    await simulation.locator('[role="option"][data-value="ContingencyAnalysis"]').click()
    await until(() => bench.session.values.program === 'ContingencyAnalysis', 'analysis chosen')
    // Every bus is faulted, so the form asks for no bus and shows no fault switch.
    assert.equal(await simulation.locator('[data-testid="field-fault"]').count(), 0)
    await simulation.locator('[data-testid="field-tmax"]').fill('0.5')
    await simulation.locator('[data-testid="field-fault_start"]').fill('0.1')
    await until(() => bench.session.values.fault_start === 0.1, 'fault timing captured')
    const previous = bench.session.run!.id
    await simulation.locator('[data-testid="simulation-start"]').click()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state === 'complete',
      'the analysis ends',
      300_000,
    )
    const study = bench.session.run!.contingency!
    assert.equal(study.buses.length, bench.source.buses.length)
    assert.deepEqual([study.done, study.shown, study.failed], [study.buses.length, 0, []])
    const before = { run: bench.session.run!.id, previous: bench.session.previous?.id }
    await simulation.locator('[data-testid="study-contingency"]').click()
    await simulation.locator('[role="option"][data-value="1"]').click()
    await until(() => bench.session.run?.contingency?.shown === 1, 'the second contingency shows')
    // It takes the study's place: the run before the study stays the previous one.
    assert.notEqual(bench.session.run!.id, before.run)
    assert.equal(bench.session.previous?.id, before.previous)
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
    await simulation.locator('[data-testid="study-program"]').click()
    await simulation.locator('[role="option"][data-value="DynamicSimulation"]').click()
    await until(() => bench.session.values.program === 'DynamicSimulation', 'simulation chosen')
    await simulation.locator('[data-testid="field-tmax"]').fill('2')
    await until(() => bench.session.values.tmax === 2, 'end time restored')
  })

  test('runs TwoArea with its native Ispdlim values and plots the result', async () => {
    await bench.replace(
      await readFile(join(process.env.GRIDKIT_TEST_ROOT!, 'cases/TwoArea.case.json'), 'utf8'),
    )
    await bench.settled()
    assert.deepEqual((await bench.current()).issues, [])
    const previous = bench.session.run!.id
    simulation = await bench.show('simulation')
    await bench.toggleSignal('Bus', 'Vm')
    await until(
      () => bench.session.outputs?.some((output) => output.select.includes('Vm')),
      'voltage recorded',
    )
    await simulation.locator('[data-testid="simulation-start"]').click()
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
    await simulation.locator('[data-testid="simulation-start"]').click()
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

  test('says once why a native run failed, keeps it out of the views, and retries after correction', async () => {
    const good = bench.document.getText()
    await bench.replace(good.replace(/"Ispdlim":\s*0\.0/, '"Ispdlim":2.0'))
    await bench.settled()
    simulation = await bench.show('simulation')
    await simulation.locator('[data-testid="field-tmax"]').fill('0.1')
    const previous = bench.session.run!.id
    await simulation.locator('[data-testid="simulation-start"]').click()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state === 'failed',
      'native initialization fails',
    )
    // The one place an error is said: a notification, and the log behind it.
    const shown = await until(async () => {
      const found = await notifications()
      return found.length ? found : undefined
    }, 'the native error reported')
    assert.equal(shown.length, 1, shown.join(' | '))
    assert.match(shown[0]!, /Ispdlim/)
    assert.equal(bench.studio.errors.splice(0).length, 1)
    monitor = await bench.view('monitor')
    simulation = await bench.view('simulation')
    for (const view of [monitor, simulation])
      assert.equal(await view.locator('.c-note--error, [role="alert"]').count(), 0)
    await bench.replace(good)
    await bench.settled()
    await simulation.locator('[data-testid="simulation-start"]').click()
    await until(() => bench.session.run?.state === 'complete', 'corrected TwoArea runs')
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
  })
})
