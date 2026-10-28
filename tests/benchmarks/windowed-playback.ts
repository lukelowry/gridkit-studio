/** Large real results: bounded native windows, cancellation, irregular reads, and picking. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as vscode from 'vscode'

import type { FrameRequest } from '../../src/shared/data.js'
import { pause, testHost, until, visible, VM } from '../vscode/harness.js'

export async function run() {
  const bench = await testHost()
  try {
    assert.ok(await bench.gridkit(), 'Installed GridKit is required')
    const { uri, network } = await bench.openCase('cases/ACTIVSg10k.case.json')
    const session = bench.studio.get(uri.toString())!
    const source = JSON.parse(await readFile(uri.fsPath, 'utf8'))
    const id: number = source.buses[0].number
    await bench.record('Bus', ['Vm', 'Va'], uri)
    bench.run(
      'Run Dynamic Simulation',
      await bench.writeSolver(
        {
          tmax: 10,
          dt_monitor: 0.01,
          events: [
            { time: 1, type: 'fault_on', element_id: 0 },
            { time: 1.15, type: 'fault_off', element_id: 0 },
          ],
        },
        uri,
      ),
    )
    await until(
      () => session.run?.state === 'complete' || session.run?.state === 'failed',
      '10k GridKit finishes',
      300_000,
    )
    assert.equal(session.run!.state, 'complete', session.run!.message)
    console.log('Windowed: real 10k simulation complete')
    const results = session.results!
    assert.ok(
      2 * source.buses.length * results.frames * 8 > 96 * 1024 * 1024,
      'Raw data exceeds the page cache',
    )
    session.transport.pause()
    session.setPlots([
      { from: 'Bus', field: 'Vm' },
      { from: 'Bus', field: 'Vm', id },
    ])
    session.bind(VM, ['vertexColor'])
    session.bind({ table: 'Bus', field: 'Va' }, ['vertexHeight'])
    await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
    const monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    const thread = bench.studio.client.results
    const original = thread.call
    let delayed = 0
    let cancelled = 0
    thread.call = (async (...args: Parameters<typeof original>) => {
      if (args[0] === 'frames' && (args[1] as FrameRequest).purpose === 'playhead') {
        delayed++
        await pause(120)
        if (args[2]?.aborted) {
          cancelled++
          args[2].throwIfAborted()
        }
      }
      return original.apply(thread, args)
    }) as typeof original
    const samples: unknown[] = []
    try {
      await network.evaluate('window.originalNetworkCanvas = document.querySelector("canvas")')
      const seek = async (at: number) => {
        console.log('Windowed: seek', at)
        const start = performance.now()
        session.transport.seek(at)
        await until(
          () =>
            network.evaluate<boolean>(
              'gridkitStats().covered && gridkitStats().complete && Math.abs(gridkitStats().at - ' +
                at +
                ') < 1e-6',
            ),
          'native window presents the requested time',
          120_000,
        )
        const held = await network.evaluate<{
          cacheBytes: number
          reads: number
          windows: { span: number[] }[]
        }>('gridkitStats()')
        assert.ok(held.cacheBytes <= 96 * 1024 * 1024 && held.reads <= 2)
        assert.ok(
          held.windows.every((window) => window.span[1]! - window.span[0]! < 10),
          'Each field holds a bounded interval',
        )
        assert.equal(
          await network.evaluate(
            'document.querySelector("canvas") === window.originalNetworkCanvas',
          ),
          true,
        )
        samples.push({ at, elapsedMs: performance.now() - start, held })
        console.log('Windowed: presented', at, Math.round(performance.now() - start), {
          cacheBytes: held.cacheBytes,
          reads: held.reads,
        })
      }
      for (const at of [9, 1, 8, 0.2]) {
        session.transport.seek(at)
        await pause(25)
      }
      await seek(0.2)
      for (const at of [8.5, 0.1, 7.8, 1.2, 9.6, 0]) await seek(at)
      for (let i = 0; i <= 100; i++) {
        session.transport.seek(2 + i * 0.03)
        await pause(16)
      }
      await seek(5)
      assert.ok(delayed > 0, 'Delayed frame reads were exercised')
      assert.ok(cancelled > 0, 'Obsolete frame reads were cancelled')
      await seek(4.5)
      const exact = await thread.call('sample', {
        results: results.id,
        table: 'Bus',
        field: 'Vm',
        id,
        at: 4.5,
      })
      assert.ok(exact && exact.value !== null)
      await monitor.locator('canvas').nth(1).scrollIntoViewIfNeeded()
      await until(
        () =>
          monitor.evaluate<boolean>(
            'document.querySelectorAll("canvas")[1]?.gridkitPlot?.().complete',
          ),
        'the target plot completes after scrolling',
      )
      const point = await monitor.evaluate<[number, number]>(
        `document.querySelectorAll('canvas')[1].gridkitPoint(4.5, ${exact.value})`,
      )
      assert.ok(point)
      const hits = await monitor.evaluate<{ row: { id: number } }[]>(
        `document.querySelectorAll('canvas')[1].gridkitRead(${JSON.stringify(point)})`,
      )
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.row.id, id)
      await monitor
        .locator('canvas')
        .nth(1)
        .click({ position: { x: point[0], y: point[1] } })
      await until(
        () => session.selection?.table === 'Bus' && session.selection.id === id,
        'native trace selection',
      )
      assert.deepEqual(bench.studio.reporter.errors, [])
    } finally {
      thread.call = original
    }
    await writeFile(
      join(bench.output, 'tests', 'windowed-playback.json'),
      JSON.stringify({ renderer: 'latkit@0.3.1', delayed, cancelled, samples }, null, 2),
    )
  } catch (error) {
    await bench.failed('windowed-playback')
    throw error
  } finally {
    await bench.finish()
  }
}
