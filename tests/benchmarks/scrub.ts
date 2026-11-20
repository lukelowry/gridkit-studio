/** Scrub benchmark on 10 s of ACTIVSg10k (Vm as color, Va as height): seek latency, drag lag and
 *  buffering. Also checks the Network's voltage and angle against the solver around the fault. */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { pause, testHost, until, visible } from '../e2e/harness.js'

const STEP_MS = 16

/** The Network's state on one animation frame. */
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

declare function gridkitStats(): Omit<Watched, 'ms'> | undefined

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
const stopWatching = (network: Frame) =>
  network.evaluate<Watched[]>('(cancelAnimationFrame(window.watching), window.watched)')

/** Reports data availability and native draw counts separately from View.complete, which can stay
 *  false while a moving playhead keeps GPU work queued. */
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
    bench.explorer(
      'Run Dynamic Simulation',
      await bench.writeSolver(
        {
          tmax: 10,
          dt_monitor: 0.01,
          events: [
            { time: 1, type: 'fault_on', bus: 30399, R: 0, X: 0.01 },
            { time: 1.15, type: 'fault_off', bus: 30399 },
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
    session.showMonitor({ table: 'Bus', field: 'Vm' })
    session.map({ table: 'Bus', field: 'Vm' }, ['vertexColor'])
    session.map({ table: 'Bus', field: 'Va' }, ['vertexHeight'])
    await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
    const monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    const drawnAt = (t: number, after = -1) =>
      network.evaluate(
        async ({ t, after }) => {
          const deadline = performance.now() + 120_000
          do {
            const stats = gridkitStats()
            if (
              stats?.covered &&
              stats.complete &&
              stats.frames > after &&
              stats.requestedAt === t &&
              stats.at === t
            )
              return
            await new Promise(requestAnimationFrame)
          } while (performance.now() < deadline)
          throw new Error(`Network did not draw a complete frame at ${t}s after frame ${after}`)
        },
        { t, after },
      )
    const firstStart = performance.now()
    await drawnAt(0)
    report.first = performance.now() - firstStart
    report.frames = session.results!.frames
    report.domain = session.results!.domain

    const [start, end] = session.results!.domain
    const at = (part: number) => start + part * (end - start)

    // Seeks far from anything drawn before.
    const seeks: number[] = []
    for (const part of [0.95, 0.05, 0.7, 0.35, 0.85]) {
      const t = transport.currentT()
      const frames = await network.evaluate<number>('gridkitStats().frames')
      const begun = performance.now()
      transport.seek(at(part))
      await drawnAt(transport.currentT(), frames)
      seeks.push(performance.now() - begun)
      assert.notEqual(t, transport.currentT())
    }
    report.seekMs = seeks

    /** Drags the playhead between fractions `from` and `to` of the run over `ms`, then waits. */
    async function drag(name: string, from: number, to: number, ms: number) {
      transport.seek(at(from))
      await drawnAt(transport.currentT())
      await watch(network)
      const begun = performance.now()
      const steps = Math.round(ms / STEP_MS)
      for (let i = 1; i <= steps; i++) {
        transport.seek(at(from + ((to - from) * i) / steps))
        await pause(STEP_MS)
      }
      const ended = performance.now() - begun
      await drawnAt(transport.currentT())
      await pause(100)
      report[name] = summarize(await stopWatching(network), ended)
    }
    // A drag over undrawn times, the same drag back, and one across the whole run.
    await drag('scrub cold', 0.2, 0.5, 2000)
    await drag('scrub back', 0.5, 0.2, 2000)
    await drag('scrub whole', 0, 1, 3000)

    // Play from a time far from the last one drawn.
    transport.seek(at(0.6))
    await drawnAt(transport.currentT())
    await watch(network)
    transport.setRate(1)
    transport.play()
    await pause(3000)
    transport.pause()
    report['play'] = summarize(await stopWatching(network), 3000)

    // At either fault transition the solver may store two samples at the same timestamp.
    const fault = []
    for (const at of [0.99, 1, 1.01, 1.14, 1.15, 1.16]) {
      const before = await network.evaluate<number>('gridkitStats().frames')
      transport.seek(at)
      await drawnAt(at, before)
      for (const field of ['Vm', 'Va'] as const) {
        const { value } = await bench.studio.client.worker.call('sample', {
          results: session.results!.id,
          table: 'Bus',
          id: 30399,
          field,
          at,
        })
        const drawn = await network.evaluate<number | null>(`gridkitSample("${field}", 30399)`)
        assert.ok(value !== null, `Missing solver sample for Bus 30399 ${field} at ${at}s`)
        assert.equal(drawn, Math.fround(value), `Bus 30399 ${field} at ${at}s`)
        fault.push({ at, field, drawn, exact: value })
      }
    }
    report.fault = fault

    assert.deepEqual(bench.studio.reporter.errors, [], 'Studio reported no error')
    const output = join(process.env.GRIDKIT_TEST_OUTPUT!, 'bench')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'scrub.json'), JSON.stringify(report, null, 2))
    console.log('Scrub: ' + JSON.stringify(report))
  } finally {
    await bench.finish()
  }
}
