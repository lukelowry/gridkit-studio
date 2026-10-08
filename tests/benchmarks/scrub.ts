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
  availability?: string
  /** The time the Network presented, and the time it was asked to show. */
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
        availability: stats?.availability,
        at: stats?.at,
        requestedAt: stats?.requestedAt,
      })
      window.watching = requestAnimationFrame(look)
    }
    look()
  })()`)
const stop = (network: Frame) =>
  network.evaluate<Watched[]>('(cancelAnimationFrame(window.watching), window.watched)')

/** How a drag went: the share of frames spent waiting on samples, the distinct times shown, and
 *  how far, in the run's seconds, what was shown trailed the playhead. */
function summarize(watched: readonly Watched[], ended: number) {
  const during = watched.filter((sample) => sample.ms <= ended)
  const lag = during
    .filter((sample) => sample.at !== undefined && sample.requestedAt !== undefined)
    .map((sample) => Math.abs(sample.requestedAt! - sample.at!))
    .sort((a, b) => a - b)
  const settled = watched.find(
    (sample) =>
      sample.ms > ended &&
      sample.availability === 'ready' &&
      Math.abs((sample.at ?? NaN) - (sample.requestedAt ?? NaN)) < 1e-6,
  )
  return {
    frames: during.length,
    buffering:
      during.filter((sample) => sample.availability === 'buffering').length /
      Math.max(1, during.length),
    shown: new Set(during.filter((s) => s.availability === 'ready').map((s) => s.at)).size,
    lagMedian: lag[Math.floor(lag.length / 2)] ?? null,
    lagMax: lag.at(-1) ?? null,
    settleMs: settled ? settled.ms - ended : null,
  }
}

export async function run() {
  const bench = await testHost()
  const report: Record<string, unknown> = {}
  try {
    assert.ok(await bench.gridkit(), 'GridKit is required')
    const { uri, network } = await bench.openCase('cases/ACTIVSg10k.case.json')
    const key = uri.toString()
    const session = bench.studio.all.get(key)!
    bench.studio.record(key, [{ from: 'Bus', select: ['Vm', 'Va'] }])
    session.values = { tmax: 10, dt_monitor: 0.01 }
    await vscode.commands.executeCommand('gridkitStudio.startSimulation', uri)
    await until(
      () => session.run?.state === 'complete' || session.run?.state === 'failed',
      'GridKit completes',
      300_000,
    )
    assert.equal(session.run!.state, 'complete', session.run!.message)
    const { transport } = session
    transport.pause()
    transport.seek(0)
    session.plots = [{ from: 'Bus', field: 'Vm' }]
    bench.studio.bind(key, { type: 'Bus', field: 'Vm' }, ['vertexColor'])
    bench.studio.bind(key, { type: 'Bus', field: 'Va' }, ['vertexHeight'])
    bench.studio.changed.fire(key)
    await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
    const monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    const shows = (t: number) =>
      network.waitForFunction(
        `(t) => gridkitStats()?.availability === 'ready' && Math.abs(gridkitStats().at - t) < 1e-6`,
        t,
        { polling: 'raf', timeout: 120_000 },
      )
    const firstShown = performance.now()
    await shows(0)
    report.first = performance.now() - firstShown
    report.frames = session.run!.frames
    report.domain = session.run!.domain

    /** Seconds of the run, as it recorded them. */
    const [start, end] = session.run!.domain
    const at = (part: number) => start + part * (end - start)

    // Seeks far from anything shown.
    const seeks: number[] = []
    for (const part of [0.95, 0.05, 0.7, 0.35, 0.85]) {
      const t = transport.currentT()
      const begun = performance.now()
      transport.seek(at(part))
      await shows(transport.currentT())
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

    assert.deepEqual(bench.studio.errors, [], 'Studio reported no error')
    const output = join(process.env.GRIDKIT_TEST_OUTPUT!, 'bench')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'scrub.json'), JSON.stringify(report, null, 2))
    console.log('Scrub: ' + JSON.stringify(report))
  } finally {
    await bench.browser.close()
  }
}
