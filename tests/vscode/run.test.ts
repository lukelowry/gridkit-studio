/** Runs against real GridKit from the views: signals, live samples, playback, a cancelled run,
 *  and a native failure. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import { again, frames, notified, type TestHost, testHost, until, visible, VM } from './harness.js'

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
    const pane = bench.page.locator('.pane', {
      has: bench.page.locator('.pane-header', { hasText: /monitored signals/i }),
    })
    await again(
      () => monitor.getByRole('button', { name: 'Choose monitored signals' }).click(),
      () => pane.getByRole('treeitem').first().isVisible(),
      'Monitored Signals shown',
    )
    const signals = await bench.signals({ reveal: false })
    // Clear every signal through the view's own title action.
    await again(
      async () => {
        await signals.locator('.pane-header').hover()
        await signals
          .getByRole('button', { name: 'Record No Signals' })
          .click({ timeout: 2000 })
          .catch(() => {})
      },
      () => !bench.session.outputs?.length,
      'all monitored fields cleared',
    )
    simulation = await bench.view('simulation')
    // Start says what keeps it from running, and offers to choose what to record.
    await bench.start()
    await bench.notice('Choose Signals').click()
    await bench.signals({ reveal: false })
    assert.equal(bench.session.launching, false)
    assert.equal(bench.studio.errors.splice(0).length, 1)
    await bench.toggleSignal('Bus', 'Vm')
    await until(() => bench.session.outputs?.length === 1, 'one selected field')
    await simulation.locator('[data-testid="field-tmax"]').fill('2')
    await simulation.locator('[data-testid="field-dt_monitor"]').fill('0.01')
    await until(() => bench.session.values.tmax === 2, 'run settings captured')
    await vscode.commands.executeCommand('workbench.action.closePanel')
    const { session } = bench
    const shown = session.run?.id
    const before = await frames(network)
    await bench.start()
    // Run itself reveals the Monitor, and nothing else: no terminal takes the panel from it.
    monitor = await bench.view('monitor')
    await until(
      () => session.run && session.run.id !== shown && session.run.frames > 0,
      'frames arrive',
      180_000,
    )
    assert.equal(await bench.panelShown(), 'Monitor')
    const followed = session.run!.state !== 'running' || session.transport.state.follow
    await until(() => session.run?.state !== 'running', 'the run ends', 300_000)
    assert.equal(session.run?.state, 'complete', session.run?.message)
    assert.ok(
      Math.abs(session.run.domain[1] - session.run.span![1]) < 1e-9,
      'the run reaches its end',
    )
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
      async () => Math.abs((await bench.times())[0]! - end) < 0.01,
      'the status bar rests at the end of the run',
    )
  })

  test('scrubs the finished run from what each view holds', async () => {
    bench.studio.bind(bench.key, VM, ['vertexColor', 'vertexHeight'])
    const rested = await frames(network)
    bench.session.transport.seek(end / 2)
    await until(async () => (await frames(network)) > rested, 'a seek repaints the network')
    assert.equal(await monitor.locator('.c-note--error').count(), 0)
    await bench.capture('run-vscode')
  })

  test('steps, replays and pauses native results from the status bar', async () => {
    const t = bench.session.transport.currentT()
    await bench.playback('Next sample').click()
    await until(() => bench.session.transport.currentT() > t, 'step one recorded sample')
    await vscode.commands.executeCommand('gridkitStudio.seekTime', end)
    await bench.playback('Replay').click()
    await until(() => bench.session.transport.state.status === 'playing', 'replay starts')
    await bench.playback('Pause').click()
    await until(() => bench.session.transport.state.status === 'paused', 'pause from the bar')
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
    await bench.start()
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
    await bench.start()
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
    if (
      !bench.session.outputs?.some(
        (output) => output.from === 'Bus' && output.select.includes('Vm'),
      )
    )
      await bench.toggleSignal('Bus', 'Vm')
    await until(
      () => bench.session.outputs?.some((output) => output.select.includes('Vm')),
      'voltage recorded',
    )
    await bench.start()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state !== 'running',
      'TwoArea ends',
    )
    const { run } = bench.session
    assert.equal(run?.state, 'complete', run?.message)
    assert.ok(Math.abs(run.domain[1] - run.span![1]) < 1e-9, 'the run reaches its end')
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
    await bench.start()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.frames! > 64,
      'live samples arrive',
    )
    assert.equal(bench.session.run?.state, 'running')
    assert.equal(bench.session.transport.state.follow, true)
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    bench.session.transport.seek(0)
    const intervals = () =>
      monitor.evaluate<number[][]>(
        'Array.from(document.querySelectorAll("canvas")).map(canvas => canvas.gridkitPlot().camera.x)',
      )
    await until(
      async () => (await intervals()).every(([start, end]) => start === 0 && end === 1000),
      'all live plots keep the configured interval',
    )
    assert.equal((await bench.times())[1], 1000)
    await bench.playback('Go live').click()
    await until(() => bench.session.transport.state.follow, 'follow live again')
    await bench.stop()
    await until(() => bench.session.run?.state === 'cancelled', 'native task cancelled')
    assert.ok(bench.session.run!.frames > 0)
    assert.ok(bench.session.run!.domain[1] < 1000)
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.ok(
      (await intervals()).every(([start, end]) => start === 0 && end === 1000),
      'cancellation keeps the configured plot interval',
    )
    assert.equal((await bench.times())[1], 1000)
    await bench.playback('Previous sample').click()
    await until(
      () => bench.session.transport.currentT() < bench.session.run!.domain[1],
      'partial results remain playable',
    )
  })

  test('says once why GridKit could not finish, and runs again once allowed', async () => {
    simulation = await bench.show('simulation')
    await simulation.locator('[data-testid="field-max_steps"]').fill('1')
    await until(() => bench.session.values.max_steps === 1, 'one solver step allowed')
    const previous = bench.session.run!.id
    await bench.start()
    const run = await until(() => {
      const { run } = bench.session
      return run?.id !== previous && run?.state === 'failed' ? run : undefined
    }, 'GridKit gives up')
    // GridKit's reason, said in one notification and in none of the views.
    const why = run.message
    assert.ok(why)
    const shown = await notified('why the run failed')
    assert.equal(shown.length, 1, shown.join(' | '))
    assert.ok(shown[0]!.includes(why), shown[0])
    assert.equal(bench.studio.errors.splice(0).length, 1)
    assert.equal(await bench.panelShown(), 'Monitor')
    for (const kind of ['simulation', 'monitor'] as const)
      assert.ok(!(await (await bench.view(kind)).locator('body').innerText()).includes(why))
    await simulation.locator('[data-testid="field-max_steps"]').fill('')
    await simulation.locator('[data-testid="field-tmax"]').fill('0.1')
    await until(
      () => bench.session.values.max_steps === undefined && bench.session.values.tmax === 0.1,
      'run settings captured',
    )
    await bench.start()
    await until(
      () => bench.session.run?.id !== run.id && bench.session.run?.state === 'complete',
      'the next run completes',
    )
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })
})
