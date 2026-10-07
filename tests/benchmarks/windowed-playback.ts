/** Real GridKit replay above the residency threshold, including delayed commits and trace clicks. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as vscode from 'vscode'

import { rowsOf } from '../../src/shared/cells.js'
import { WHOLE_RUN_BYTES } from '../../src/shared/streams.js'
import { notifications, pause, testHost, until, visible, VM } from '../vscode/harness.js'

export async function run() {
  const bench = await testHost()
  try {
    assert.ok(await bench.gridkit(), 'Installed GridKit is required')
    const { uri, network } = await bench.openCase('cases/ACTIVSg10k.case.json')
    const key = uri.toString()
    const session = bench.studio.all.get(key)!
    const source = JSON.parse(await readFile(uri.fsPath, 'utf8'))
    const id = `Bus/${source.buses[0].number}`
    bench.studio.record(key, [{ from: 'Bus', select: ['Vm'] }])
    session.values = { tmax: 10, dt_monitor: 0.01 }
    await vscode.commands.executeCommand('gridkitStudio.startSimulation', uri)
    await until(
      () => session.run?.state === 'complete' || session.run?.state === 'failed',
      '10k GridKit completes',
      240_000,
    )
    assert.equal(session.run!.state, 'complete', session.run!.message)
    assert.ok(
      source.buses.length * session.run!.frames * 8 > WHOLE_RUN_BYTES,
      'Must exercise windowed residency',
    )
    session.transport.pause()
    session.plots = [
      { from: 'Bus', field: 'Vm' },
      { from: 'Bus', field: 'Vm', id },
    ]
    bench.studio.bind(key, VM, ['vertexColor'])
    bench.studio.changed.fire(key)
    await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
    const monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    await until(
      () =>
        monitor
          .locator('canvas[data-rendered=true]')
          .count()
          .then((n) => n === 2),
      'both plots render',
      60_000,
    )
    await until(
      () => network.evaluate<boolean>('!!gridkitStats()?.held'),
      'network uses a bounded window',
    )
    await network.evaluate(`(() => {
      window.originalNetworkCanvas = document.querySelector('canvas');
      window.windowCommits = 0;
      window.addEventListener('message', event => {
        const m = event.data;
        if (m?.kind !== 'end' || m.delayedForTest) return;
        event.stopImmediatePropagation();
        window.windowCommits++;
        setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { ...m, delayedForTest: true } })), 120);
      }, true);
    })()`)
    const samples: { requested: number; elapsedMs: number; shown: unknown }[] = []
    const seek = async (at: number) => {
      const started = performance.now()
      session.transport.seek(at)
      await until(
        () =>
          network.evaluate<boolean>(
            `gridkitStats().availability === 'ready' && Math.abs(gridkitStats().at - ${at}) < 0.002`,
          ),
        `network presents ${at}`,
        60_000,
      )
      assert.equal(
        await network.evaluate('document.querySelector("canvas") === window.originalNetworkCanvas'),
        true,
        'Cache misses must not remount the renderer',
      )
      samples.push({
        requested: at,
        elapsedMs: performance.now() - started,
        shown: await network.evaluate('gridkitStats()'),
      })
    }
    // A seek received while another destination is loading must win over that transaction.
    for (const at of [9, 1, 8, 0.2]) {
      session.transport.seek(at)
      await pause(25)
    }
    await seek(0.2)
    for (const at of [8.5, 0.1, 7.8, 1.2, 9.6, 0]) await seek(at)
    await seek(8.5)
    const cachedStream = await network.evaluate<number>('gridkitStats().stream')
    await seek(0.2)
    await seek(8.5)
    assert.equal(
      await network.evaluate('gridkitStats().stream'),
      cachedStream,
      'Returning to a resident window reuses its committed snapshot',
    )
    await seek(4.5)
    const windowCommits = await network.evaluate<number>('window.windowCommits')
    assert.ok(windowCommits >= 1, 'Must exercise a delayed cache miss')
    const query = await bench.studio.client.call('query', {
      uri: key,
      version: bench.studio.state(key).summary!.version,
      run: session.run!.id,
      query: {
        kind: 'rows',
        from: 'Bus',
        select: ['Vm'],
        rows: { kind: 'ids', ids: [id] },
        at: 4.5,
      },
    })
    const value = Number(rowsOf(query.filter((block) => block.kind === 'rows'))[0]!.values.Vm)
    const point = await monitor.evaluate<[number, number]>(
      `document.querySelectorAll('canvas')[1].gridkitPoint(4.5, ${value})`,
    )
    assert.ok(point)
    const hits = await monitor.evaluate<{ id: string }[]>(
      `document.querySelectorAll('canvas')[1].gridkitRead(${JSON.stringify(point)})`,
    )
    assert.equal(hits.length, 1, 'One trace produces one hit')
    assert.equal(hits[0]!.id, id)
    const densePick = await monitor.evaluate<{ elapsedMs: number; ids: string[] }>(`(async () => {
      const canvas = document.querySelectorAll('canvas')[0];
      const point = canvas.gridkitPoint(4.5, ${value});
      const start = performance.now();
      const hits = await canvas.gridkitRead(point);
      return { elapsedMs: performance.now() - start, ids: hits.map(hit => hit.id) };
    })()`)
    assert.ok(densePick.ids.length > 1, 'Dense plot offers overlapping traces')
    assert.equal(
      new Set(densePick.ids).size,
      densePick.ids.length,
      'Dense hit list contains distinct traces',
    )
    assert.deepEqual(await notifications(), [], 'No unexpected notifications cover the canvas')
    await monitor
      .locator('canvas')
      .nth(1)
      .click({ position: { x: point[0], y: point[1] } })
    await until(() => session.selection?.id === id, 'mouse selects the rendered trace')
    bench.studio.select(key)
    session.transport.play()
    await pause(150)
    await monitor
      .locator('canvas')
      .nth(1)
      .click({ position: { x: point[0], y: point[1] } })
    await until(
      () => session.selection?.id === id,
      'trace selection remains valid while only the clock changes',
    )
    session.transport.pause()
    const windows = await monitor.evaluate<number[][]>(
      `Array.from(document.querySelectorAll('canvas')).map(c => c.gridkitPlot().camera.x)`,
    )
    assert.ok(
      windows.every((window) => window[0] === 0 && window[1] === 10),
      'Configured interval stays fixed',
    )
    assert.deepEqual(bench.studio.errors, [])
    await writeFile(
      join(bench.output, 'tests', 'windowed-playback.json'),
      JSON.stringify(
        {
          frames: session.run!.frames,
          rows: source.buses.length,
          windowCommits,
          samples,
          hits,
          densePick,
          windows,
          errors: bench.studio.errors,
        },
        null,
        2,
      ),
    )
    console.log(
      `10k replay passed: ${session.run!.frames} frames, delayed window commits, rapid seeks, real trace click, fixed intervals; no errors.`,
    )
  } catch (error) {
    console.error('Studio errors:', JSON.stringify(bench.studio.errors))
    const frame = await bench.view('monitor').catch(() => undefined)
    if (frame) console.error('Monitor state:', await frame.evaluate('document.body.innerText'))
    await bench.failed('windowed-playback')
    throw error
  } finally {
    await bench.finish()
  }
}
