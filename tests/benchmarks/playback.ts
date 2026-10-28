/** Sustained native playback, shared GPU ownership, bounded reads, visibility, and recovery. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { FrameRequest } from '../../src/shared/data.js'
import { pause, replaying, testHost, until, visible } from '../vscode/harness.js'

interface Plot {
  frames: number
  at: number
  complete: boolean
  camera: { x: number[]; y: number[] | null }
}
interface State {
  cacheBytes: number
  reads: number
  views: number
  resident: number
  work: Record<string, number>
  plots: Plot[]
}
export async function run() {
  const bench = await testHost()
  try {
    assert.ok(await bench.gridkit(), 'Installed GridKit is required')
    await bench.record('Bus', ['Vm', 'Va'])
    bench.run(
      'Run Dynamic Simulation',
      await bench.writeSolver({
        tmax: 2,
        dt_monitor: 0.005,
        events: [
          { time: 0.5, type: 'fault_on', element_id: 0 },
          { time: 0.6, type: 'fault_off', element_id: 0 },
        ],
      }),
    )
    await until(
      () => bench.session.run?.state === 'complete' || bench.session.run?.state === 'failed',
      'GridKit finishes',
      180_000,
    )
    assert.equal(bench.session.run!.state, 'complete', bench.session.run!.message)
    console.log('Playback: real simulation complete')
    const allPlots = [
      { from: 'Bus', field: 'Vm' },
      { from: 'Bus', field: 'Va' },
      ...bench.source.buses
        .slice(0, 8)
        .map((bus) => ({ from: 'Bus', field: 'Vm', id: bus.number })),
    ]
    bench.session.setPlots(allPlots)
    const monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    const state = () => monitor.evaluate<State>('gridkitMonitor()')
    const firstPlot = () =>
      monitor.evaluate<Plot | undefined>(
        "document.querySelector('.lane:first-child canvas')?.gridkitPlot?.()",
      )
    await until(
      async () => (await state()).views > 0 && (await state()).reads === 0,
      'visible plots are loaded',
    )
    const thread = bench.studio.client.results
    const original = thread.call
    let requests = 0
    thread.call = (async (...args: Parameters<typeof original>) => {
      if (args[0] === 'frames') requests++
      return original.apply(thread, args)
    }) as typeof original
    const before = await state()
    const samples: State[] = []
    const { transport } = bench.session
    const replay = replaying(bench.studio, bench.session)
    try {
      transport.seek(0)
      transport.play()
      for (let i = 0; i < Number(process.env.GRIDKIT_PLAYBACK_SECONDS ?? 30) * 2; i++) {
        await pause(500)
        const current = await state()
        assert.ok(current.reads <= 2 && current.cacheBytes <= 96 * 1024 * 1024)
        assert.ok(current.views > 0 && current.views < 10, 'Only visible plots own Views')
        const previous = samples.at(-1) ?? before
        assert.ok(
          current.plots[0]!.frames > previous.plots[0]!.frames,
          'Playback presents every half second',
        )
        samples.push(current)
      }
      assert.equal(requests, 0, 'The GPU playhead does not trigger frame RPCs')
      console.log('Playback: sustained rendering and cache bounds passed')
    } finally {
      replay.dispose()
      transport.pause()
      thread.call = original
    }
    const seek = async (at: number) => {
      transport.seek(at)
      await until(
        async () => (await state()).plots.every((plot) => Math.abs(plot.at - at) < 0.001),
        'visible plots show the seek',
      )
    }
    for (const at of [1.8, 0.1, 1.2, 0.5]) await seek(at)
    await monitor.evaluate("document.querySelector('.monitor__lanes').scrollTop = 10000")
    await until(
      async () =>
        monitor.evaluate<boolean>(
          "!!document.querySelector('.lane:last-child canvas')?.gridkitPlot",
        ),
      'cold plot attaches on scroll',
    )
    await seek(1)
    await bench.show('case')
    await until(async () => (await state()).views === 0, 'hidden panel releases every View')
    await bench.show('monitor')
    await monitor.evaluate("document.querySelector('.monitor__lanes').scrollTop = 0")
    await visible(monitor, 'canvas[data-rendered=true]')
    bench.studio.action.fire({
      uri: bench.key,
      view: 'monitor',
      command: 'valueRange',
      value: { plot: allPlots[0], range: [0.5, 1.5] },
    })
    await until(
      async () => (await firstPlot())?.camera.y?.join() === '0.5,1.5',
      'manual range applied',
    )
    console.log('Playback: visibility and seeks passed')
    const recovering = replaying(bench.studio, bench.session)
    transport.play()
    try {
      for (let loss = 0; loss < 2; loss++) {
        await monitor.evaluate(`(async () => {
        window.oldMonitorCanvas = document.querySelector('canvas');
        const device = await new Promise(resolve => {
          const original = GPUDevice.prototype.createCommandEncoder;
          GPUDevice.prototype.createCommandEncoder = function(...args) {
            GPUDevice.prototype.createCommandEncoder = original;
            resolve(this); return original.apply(this, args);
          };
        }); device.destroy();
      })()`)
        await until(
          () =>
            monitor.evaluate<boolean>(
              "document.querySelector('canvas') !== window.oldMonitorCanvas && document.querySelector('canvas')?.gridkitPlot?.().frames > 2",
            ),
          'native GPU recovery recreates Views',
        )
        assert.deepEqual(
          (await firstPlot())!.camera.y,
          [0.5, 1.5],
          'Recovery keeps the value range',
        )
      }
    } finally {
      recovering.dispose()
      transport.pause()
    }
    console.log('Playback: native GPU recovery passed')
    transport.pause()
    const expected = bench.studio.reporter.errors.splice(0)
    assert.ok(
      expected.every((error) => /device|destroy|lost/i.test(error)),
      expected.join('\n'),
    )
    // Reload retries a failed native frame request and invalidates the shared encoded cache.
    let injected = false
    thread.call = (async (...args: Parameters<typeof original>) => {
      // A resize can cancel the first request before its error is delivered. Keep the fault
      // active until a current request reports it; obsolete requests must remain silent.
      if (args[0] === 'frames' && (args[1] as FrameRequest).field === 'Va') {
        injected = true
        throw Object.assign(new Error('Injected frame read failure'), { code: 'io' })
      }
      return original.apply(thread, args)
    }) as typeof original
    try {
      bench.studio.action.fire({ uri: bench.key, view: 'monitor', command: 'reloadView' })
      await until(
        () => injected && bench.studio.reporter.errors.length > 0,
        'frame failure reported',
      )
    } finally {
      thread.call = original
    }
    assert.ok(
      bench.studio.reporter.errors
        .splice(0)
        .every((error) => /Injected frame read failure/.test(error)),
    )
    bench.studio.action.fire({ uri: bench.key, view: 'monitor', command: 'reloadView' })
    await until(
      async () =>
        (await state()).plots.length >= 2 && (await state()).plots.every((plot) => plot.frames > 0),
      'native sources reload',
    )
    await seek(0.8)
    assert.deepEqual(bench.studio.reporter.errors, [])
    await writeFile(
      join(bench.output, 'tests', 'playback.json'),
      JSON.stringify(
        { renderer: 'latkit@0.3.1', before, samples, after: await state(), requests },
        null,
        2,
      ),
    )
    await bench.capture('native-playback')
  } catch (error) {
    await bench.failed('native-playback')
    throw error
  } finally {
    await bench.finish()
  }
}
