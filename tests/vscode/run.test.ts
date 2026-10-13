/** Runs against real GridKit from a solver file's menu: what the case records, live samples,
 *  playback, results shown again and run again, a cancelled run, and a native failure. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Block } from '@latkit/model'
import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import { rowsOf } from '../../src/shared/cells.js'
import {
  again,
  folder,
  frames,
  notified,
  type TestHost,
  testHost,
  until,
  visible,
  VM,
} from './harness.js'

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
  let end = 0

  suiteSetup(async function () {
    bench = await testHost()
    if (!(await bench.gridkit())) this.skip()
    network = await bench.open('network')
  })

  test('records what Recorded Signals checks, and runs from the solver file in place', async () => {
    assert.deepEqual(bench.session.plots, [])
    monitor = await bench.show('monitor')
    // Without results, the Monitor says how to get them.
    await until(
      async () =>
        /Run Dynamic Simulation/.test(
          await monitor
            .locator('.c-empty__text')
            .innerText()
            .catch(() => ''),
        ),
      'the Monitor says how to run',
    )
    const signals = await bench.signals()
    // Record nothing, through the view's own title action: the case's every list goes empty.
    const listed = () => Object.keys(bench.studio.state(bench.key).summary?.recording.listed ?? {})
    await again(
      async () => {
        await signals.locator('.pane-header').hover()
        await signals
          .getByRole('button', { name: 'Record No Signals' })
          .click({ timeout: 2000 })
          .catch(() => {})
      },
      () => !listed().length,
      'the case records nothing',
    )
    // A run says what keeps it from starting, and offers to choose what to record, which brings
    // the view back into sight.
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    bench.run()
    await bench.notice('Choose Signals').click()
    await bench.signals({ reveal: false })
    assert.equal(bench.studio.reporter.errors.splice(0).length, 1)
    await bench.toggleSignal('Bus', 'Vm')
    assert.deepEqual(listed(), ['Bus'])
    await bench.writeSolver({ tmax: 2, dt_monitor: 0.01, events: [] })
    await vscode.commands.executeCommand('workbench.action.closePanel')
    const { session } = bench
    const before = await frames(network)
    bench.run()
    // The run reveals the Monitor, and nothing else: no terminal takes the panel from it.
    monitor = await bench.view('monitor')
    await until(() => (session.results?.frames ?? 0) > 0, 'frames arrive', 180_000)
    assert.equal(await bench.panelShown(), 'Monitor')
    // GridKit reads the files as saved, so the edited case was saved first.
    assert.equal(bench.document.isDirty, false)
    const followed = session.run!.state !== 'running' || session.transport.state.follow
    await until(() => session.run?.state !== 'running', 'the run ends', 300_000)
    assert.equal(session.run?.state, 'complete', session.run?.message)
    const results = session.results!
    assert.ok(Math.abs(results.domain[1] - results.span![1]) < 1e-9, 'the run reaches its end')
    assert.equal(results.growing, false)
    // GridKit wrote where the solver file says, and that is the file the Monitor reads.
    const written = vscode.Uri.joinPath(folder(), 'output', 'IEEE39.csv')
    await vscode.workspace.fs.stat(written)
    assert.equal(results.path, written.fsPath)
    assert.equal(session.run.command, 'DynamicSimulation IEEE39.solver.json')
    assert.deepEqual(session.plots, [{ from: 'Bus', field: 'Vm' }])
    await visible(monitor, 'canvas[data-rendered=true]')
    // The plot reads its trace while it holds focus: focus the run's own views take is given back.
    const reading = () => monitor.locator('.lane [role="status"]').innerText()
    /** Whether the reading says the voltage the run wrote for its bus at the playhead: "1,
     *  1.04852 pu, 10.000 s." */
    const read = async () => {
      const said = /^(.+?), (-?[\d.]+(?:e[-+]?\d+)?)/.exec(await reading())
      if (!said) return false
      const blocks = await bench.studio.client.results.call('query', {
        results: results.id,
        query: {
          kind: 'rows',
          from: 'Bus',
          select: ['Vm'],
          ids: true,
          rows: { kind: 'ids', ids: ['Bus/' + said[1]] },
          at: bench.session.transport.currentT(),
        },
      })
      const wrote = rowsOf(blocks as Block.Rows[])[0]?.values.Vm
      return typeof wrote === 'number' && Math.abs(Number(said[2]) - wrote) < 1e-3
    }
    await again(
      () => monitor.locator('canvas').focus(),
      read,
      async () => {
        const { status, follow } = bench.session.transport.state
        const plot = await monitor
          .locator('canvas')
          .first()
          .evaluate((canvas) =>
            (
              canvas as unknown as { gridkitPlot(): { at?: number; paused: boolean } }
            ).gridkitPlot(),
          )
        const live = await monitor.locator('.lane [role="status"]').getAttribute('aria-live')
        const focused = (name: string) =>
          `(document.hasFocus() ? 'has' : 'lacks') + ' focus on ' + document.activeElement?.${name}`
        const focus = await monitor.evaluate<string>(focused('tagName'))
        const page = await bench.page.evaluate<string>(focused('className'))
        return `the plotted trace reads a native voltage: it read "${await reading()}", the clock ${status}${follow ? ' and following' : ''} at ${bench.session.transport.currentT()}, the plot at ${plot.at}${plot.paused ? ' paused' : ''} with its reading ${live === 'off' ? 'off' : 'on'}, the Monitor ${focus}, the window ${page}, the results ${JSON.stringify({ frames: session.results?.frames, domain: session.results?.domain })}`
      },
    )
    assert.ok(followed, 'The playhead follows a run as it arrives')
    const plot = PNG.sync.read(await monitor.locator('canvas').screenshot())
    assert.ok(
      colored(plot) > plot.width,
      'Native traces must be painted, not just axes and a playhead',
    )
    bench.report.run = {
      frames: results.frames,
      domain: results.domain,
      painted: (await frames(network)) - before,
    }
  })

  test('rests at the end of the finished run, the Monitor on show again', async () => {
    const { results, transport } = bench.session
    end = results!.domain[1]
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
    bench.session.bind(VM, ['vertexColor', 'vertexHeight'])
    const rested = await frames(network)
    bench.session.transport.seek(end / 2)
    await until(async () => (await frames(network)) > rested, 'a seek repaints the network')
    await bench.capture('run-vscode')
  })

  test('steps, replays and pauses native results from the status bar', async () => {
    const t = bench.session.transport.currentT()
    await bench.playback('Next sample').click()
    await until(() => bench.session.transport.currentT() > t, 'step one recorded sample')
    await vscode.commands.executeCommand('gridkitStudio.goToTime', end)
    await bench.playback('Replay').click()
    await until(() => bench.session.transport.state.status === 'playing', 'replay starts')
    await bench.playback('Pause').click()
    await until(() => bench.session.transport.state.status === 'paused', 'pause from the bar')
  })

  test('shows what its solver file wrote last, and runs that solver file again', async () => {
    const written = bench.session.results!
    assert.equal(written.solver, bench.solver.fsPath)
    await bench.title('monitor', 'Clear Results')
    await until(() => !bench.session.results, 'the results go')
    // The solver file's menu reads the file its runs write, as written.
    bench.explorer(bench.solver, 'Show Last Results')
    await until(
      () => bench.session.results?.frames === written.frames,
      'the solver file’s results show again',
    )
    assert.equal(bench.session.results!.path, written.path)
    assert.equal(bench.session.results!.solver, bench.solver.fsPath)
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    // The Monitor's title bar runs the solver file of the results it shows.
    const previous = bench.session.run?.id
    await bench.title('monitor', 'Run Simulation Again')
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state === 'complete',
      'the solver file runs again',
    )
    assert.equal(bench.session.run!.command, 'DynamicSimulation IEEE39.solver.json')
    assert.equal(bench.session.results!.solver, bench.solver.fsPath)
    assert.deepEqual(bench.session.plots, [{ from: 'Bus', field: 'Vm' }])
  })

  test('keeps existing plots until the next run, which plots what it recorded', async () => {
    const previous = bench.session.run!.id
    await bench.toggleSignal('Bus', 'Va')
    await bench.toggleSignal('Bus', 'Vm')
    assert.ok(bench.recorded('Bus', 'Va') && !bench.recorded('Bus', 'Vm'))
    assert.deepEqual(bench.session.plots, [{ from: 'Bus', field: 'Vm' }])
    assert.equal(bench.session.results!.outputs[0]!.select[0], 'Vm')
    bench.run()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state === 'complete',
      'second run completes',
    )
    assert.deepEqual(bench.session.plots, [{ from: 'Bus', field: 'Va' }])
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('runs TwoArea with its native Ispdlim values and plots the result', async () => {
    await bench.replace(
      await readFile(join(process.env.GRIDKIT_TEST_ROOT!, 'cases/TwoArea.case.json'), 'utf8'),
    )
    await bench.settled()
    assert.deepEqual((await bench.current()).issues, [])
    if (!bench.recorded('Bus', 'Vm')) await bench.toggleSignal('Bus', 'Vm')
    await bench.writeSolver({ tmax: 2, dt_monitor: 0.01, events: [] })
    const previous = bench.session.run!.id
    bench.run()
    await until(
      () => bench.session.run?.id !== previous && bench.session.run?.state !== 'running',
      'TwoArea ends',
    )
    const { run, results } = bench.session
    assert.equal(run?.state, 'complete', run?.message)
    assert.ok(Math.abs(results!.domain[1] - results!.span![1]) < 1e-9, 'the run reaches its end')
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    await bench.capture('run-twoarea')
  })

  test('follows live samples, stops the run from the Monitor and keeps partial plots', async () => {
    await bench.writeSolver({ tmax: 1000, dt_monitor: 0.001, events: [] })
    const previous = bench.session.run!.id
    bench.run()
    // The last run's results stay on show until this run's file says what it holds; then its own
    // take their place, followed live.
    await until(
      () =>
        bench.session.run?.id !== previous &&
        bench.session.live &&
        (bench.session.results?.frames ?? 0) > 64,
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
      'all live plots keep the solver file’s end time',
    )
    assert.equal((await bench.times())[1], 1000)
    // Go to End goes to the head of a run still writing, and follows it.
    await bench.palette('Go to End')
    await until(() => bench.session.transport.state.follow, 'follow live again')
    await bench.stop()
    await until(() => bench.session.run?.state === 'cancelled', 'the run stopped')
    assert.ok(bench.session.results!.frames > 0)
    assert.ok(bench.session.results!.domain[1] < 1000)
    assert.equal(bench.session.results!.growing, false)
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.ok(
      (await intervals()).every(([start, end]) => start === 0 && end === 1000),
      'a stopped run keeps its plot interval',
    )
    assert.equal((await bench.times())[1], 1000)
    await bench.playback('Previous sample').click()
    await until(
      () => bench.session.transport.currentT() < bench.session.results!.domain[1],
      'partial results remain playable',
    )
  })

  test('says once why GridKit could not finish, and runs again once allowed', async () => {
    await bench.writeSolver({ tmax: 0.1, dt_monitor: 0.01, max_steps: 1, events: [] })
    const previous = bench.session.run!.id
    bench.run()
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
    assert.equal(bench.studio.reporter.errors.splice(0).length, 1)
    assert.equal(await bench.panelShown(), 'Monitor')
    assert.ok(!(await (await bench.view('monitor')).locator('body').innerText()).includes(why))
    await bench.writeSolver({ tmax: 0.1, dt_monitor: 0.01, events: [] })
    bench.run()
    await until(
      () => bench.session.run?.id !== run.id && bench.session.run?.state === 'complete',
      'the next run completes',
    )
    monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })
})
