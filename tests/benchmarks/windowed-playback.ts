/** Real GridKit replay past what the Network holds at once, two fields mapped, including delayed
 *  samples, a scrub through times not yet held, and trace clicks. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as vscode from 'vscode'

import { rowsOf } from '../../src/shared/cells.js'
import { SAMPLE_BUDGET } from '../../src/webview/samples.js'
import { notifications, pause, testHost, until, visible, VM } from '../vscode/harness.js'

/** What the Network holds of the results: chunks, and their bytes. */
type Held = { held: number; bytes: number }

export async function run() {
  const bench = await testHost()
  try {
    assert.ok(await bench.gridkit(), 'Installed GridKit is required')
    const { uri, network } = await bench.openCase('cases/ACTIVSg10k.case.json')
    const key = uri.toString()
    const session = bench.studio.all.get(key)!
    const source = JSON.parse(await readFile(uri.fsPath, 'utf8'))
    const id = `Bus/${source.buses[0].number}`
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
      '10k GridKit completes',
      240_000,
    )
    assert.equal(session.run!.state, 'complete', session.run!.message)
    const results = session.results!
    assert.ok(
      2 * source.buses.length * results.frames * 8 > SAMPLE_BUDGET,
      'The two mapped fields must exceed what the Network holds at once',
    )
    session.transport.pause()
    session.plots = [
      { from: 'Bus', field: 'Vm' },
      { from: 'Bus', field: 'Vm', id },
    ]
    bench.studio.bind(key, VM, ['vertexColor'])
    bench.studio.bind(key, { type: 'Bus', field: 'Va' }, ['vertexHeight'])
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
    const held = () => network.evaluate<Held>('gridkitStats().samples')
    const chunks = Math.ceil(results.frames / results.chunk)
    await until(async () => {
      const { held: some } = await held()
      return some > 0 && some < 2 * chunks
    }, 'network holds part of the results')
    // Each reply of samples comes late, as from a busy worker.
    await network.evaluate(`(() => {
      window.originalNetworkCanvas = document.querySelector('canvas');
      window.delayed = 0;
      window.addEventListener('message', event => {
        const m = event.data;
        if (m?.kind !== 'reply' || m.delayedForTest || m.value?.[0]?.kind !== 'samples') return;
        event.stopImmediatePropagation();
        window.delayed++;
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
    // Once the chunks around a moment are held, moving among them waits on no sample.
    await seek(8.5)
    await until(
      async () => {
        const before = (await held()).held
        await pause(500)
        return (await held()).held === before
      },
      'the chunks around 8.5 held',
      60_000,
    )
    /** Count the frames the Network waits on samples, until `waited` stops counting. */
    const waiting = () =>
      network.evaluate(`(() => {
        window.waited = 0
        const look = () => {
          if (gridkitStats()?.availability === 'buffering') window.waited++
          window.looking = requestAnimationFrame(look)
        }
        look()
      })()`)
    const waited = () =>
      network.evaluate<number>('(cancelAnimationFrame(window.looking), window.waited)')
    await waiting()
    for (const at of [8.3, 8.7, 8.1, 8.5]) await seek(at)
    assert.equal(await waited(), 0, 'Moving among held chunks waits on no sample')
    // A scrub through times it may not hold presents them on its way, not only where it rests. It
    // lasts a few of the slowest loads above, so a load it lets finish shows before it ends.
    const load = Math.max(...samples.map((sample) => sample.elapsedMs))
    await network.evaluate(`(() => {
      window.scrubbed = []
      const look = () => {
        const stats = gridkitStats()
        if (stats?.availability === 'ready') window.scrubbed.push(stats.at)
        window.scrubbing = requestAnimationFrame(look)
      }
      look()
    })()`)
    const steps = 100
    for (let i = 0; i <= steps; i++) {
      session.transport.seek(2 + (3 * i) / steps)
      await pause(Math.max(16, (3 * load) / steps))
    }
    const scrubbed = await network.evaluate<number[]>(
      '(cancelAnimationFrame(window.scrubbing), window.scrubbed)',
    )
    assert.ok(
      scrubbed.some((at) => at > 2.1 && at < 4.9),
      'A scrub presents the times it passes, not only where it rests',
    )
    await seek(4.5)
    const delayed = await network.evaluate<number>('window.delayed')
    assert.ok(delayed >= 1, 'Must exercise a delayed cache miss')
    const query = await bench.studio.client.call('query', {
      uri: key,
      version: bench.studio.state(key).summary!.version,
      results: results.id,
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
          frames: results.frames,
          rows: source.buses.length,
          delayed,
          samples,
          scrubbed: new Set(scrubbed).size,
          held: await held(),
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
      `10k replay passed: ${results.frames} frames, delayed samples, rapid seeks, a scrub, real trace click, fixed intervals; no errors.`,
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
