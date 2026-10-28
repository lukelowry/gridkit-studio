/** Scrubbing a large run with the Network mapping two of its fields: how soon a seek shows, how
 *  closely the Network follows a drag, and how long it waits on samples. Real GridKit, ACTIVSg10k,
 *  ten seconds of voltage magnitude and angle, one mapped to color and the other to height. No time
 *  fails a run; it fails only when a view stops answering or Studio reports an error. */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { pause, testHost, until, visible } from '../vscode/harness.js'

/** A playhead drag at the display's pace. */
const STEP_MS = 16

/** What the Network showed on each of its animation frames while a scenario ran. */
interface Watched {
  /** Milliseconds since the scenario began. */
  ms: number
  covered?: boolean
  frames: number
  complete: boolean
  /** Native View.at is the assigned time, not a presentation timestamp. */
  at?: number
  requestedAt?: number
}

/** Record what the Network shows each animation frame, until `stop`. */
const watch = (network: Frame) =>
  network.evaluate(`(() => {
    const start = performance.now()
    window.watched = []
    const look = () => {
      const stats = gridkitStats()
      window.watched.push({
        ms: performance.now() - start,
        covered: stats?.covered,
        frames: stats?.frames ?? 0,
        complete: stats?.complete ?? false,
        at: stats?.at,
        requestedAt: stats?.requestedAt,
      })
      window.watching = requestAnimationFrame(look)
    }
    look()
  })()`)
const stop = (network: Frame) =>
  network.evaluate<Watched[]>('(cancelAnimationFrame(window.watching), window.watched)')

/** Data availability and actual native draw counts are separate from View.complete, which may
 *  stay false while a changing playhead keeps new GPU work queued. */
function summarize(watched: readonly Watched[], ended: number) {
  const during = watched.filter((sample) => sample.ms <= ended)
  const lag = during
    .filter((sample) => sample.at !== undefined && sample.requestedAt !== undefined)
    .map((sample) => Math.abs(sample.requestedAt! - sample.at!))
    .sort((a, b) => a - b)
  const settled = watched.find(
    (sample) =>
      sample.ms > ended &&
      sample.covered &&
      Math.abs((sample.at ?? NaN) - (sample.requestedAt ?? NaN)) < 1e-6,
  )
  return {
    frames: during.length,
    drawn: Math.max(0, (during.at(-1)?.frames ?? 0) - (during[0]?.frames ?? 0)),
    complete: during.filter((sample) => sample.complete).length / Math.max(1, during.length),
    buffering: during.filter((sample) => !sample.covered).length / Math.max(1, during.length),
    assigned: new Set(during.filter((s) => s.covered).map((s) => s.at)).size,
    lagMedian: lag[Math.floor(lag.length / 2)] ?? null,
    lagMax: lag.at(-1) ?? null,
    settleMs: settled ? settled.ms - ended : null,
  }
}

export async function run() {
  const bench = await testHost()
  const report: Record<string, unknown> = {}
  report.timeSemantics =
    'View.at is assigned time; drawn counts View.stats.frames. Seek latency waits for a new native frame.'
  try {
    assert.ok(await bench.gridkit(), 'GridKit is required')
    const { uri, network } = await bench.openCase('cases/ACTIVSg10k.case.json')
    const key = uri.toString()
    const session = bench.studio.get(key)!
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
      'GridKit completes',
      300_000,
    )
    assert.equal(session.run!.state, 'complete', session.run!.message)
    const { transport } = session
    transport.pause()
    transport.seek(0)
    session.setPlots([{ from: 'Bus', field: 'Vm' }])
    session.bind({ table: 'Bus', field: 'Vm' }, ['vertexColor'])
    session.bind({ table: 'Bus', field: 'Va' }, ['vertexHeight'])
    await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
    const monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    const shows = (t: number, after = -1) =>
      network.waitForFunction(
        `([t, after]) => gridkitStats()?.frames > after && gridkitStats()?.covered && gridkitStats()?.complete && Math.abs(gridkitStats().at - t) < 1e-6`,
        [t, after],
        { polling: 'raf', timeout: 120_000 },
      )
    const firstShown = performance.now()
    await shows(0)
    report.first = performance.now() - firstShown
    report.frames = session.results!.frames
    report.domain = session.results!.domain

    /** Seconds of the run, as it recorded them. */
    const [start, end] = session.results!.domain
    const at = (part: number) => start + part * (end - start)

    // Seeks far from anything shown.
    const seeks: number[] = []
    for (const part of [0.95, 0.05, 0.7, 0.35, 0.85]) {
      const t = transport.currentT()
      const frames = await network.evaluate<number>('gridkitStats().frames')
      const begun = performance.now()
      transport.seek(at(part))
      await shows(transport.currentT(), frames)
      seeks.push(performance.now() - begun)
      assert.notEqual(t, transport.currentT())
    }
    report.seekMs = seeks

    /** Drag the playhead from `from` to `to`, parts of the run, over `ms`, then let it rest. */
    async function drag(name: string, from: number, to: number, ms: number) {
      transport.seek(at(from))
      await shows(transport.currentT())
      await watch(network)
      const begun = performance.now()
      const steps = Math.round(ms / STEP_MS)
      for (let i = 1; i <= steps; i++) {
        transport.seek(at(from + ((to - from) * i) / steps))
        await pause(STEP_MS)
      }
      const ended = performance.now() - begun
      await shows(transport.currentT())
      await pause(100)
      report[name] = summarize(await stop(network), ended)
    }
    // A drag over times not yet shown, the same one back, and one across the whole run.
    await drag('scrub cold', 0.2, 0.5, 2000)
    await drag('scrub back', 0.5, 0.2, 2000)
    await drag('scrub whole', 0, 1, 3000)

    // Playing from a moment far from the last one shown.
    transport.seek(at(0.6))
    await shows(transport.currentT())
    await watch(network)
    transport.setRate(1)
    transport.play()
    await pause(3000)
    transport.pause()
    report['play'] = summarize(await stop(network), 3000)

    assert.deepEqual(bench.studio.reporter.errors, [], 'Studio reported no error')
    const output = join(process.env.GRIDKIT_TEST_OUTPUT!, 'bench')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'scrub.json'), JSON.stringify(report, null, 2))
    console.log('Scrub: ' + JSON.stringify(report))
  } finally {
    await bench.finish()
  }
}
