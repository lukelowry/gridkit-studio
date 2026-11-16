/** Per-case view benchmarks inside VS Code: first frames and interaction latency, plus a 1 s live
 *  simulation, playback, plots and export when GridKit is available. Read by compare.mjs. */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import type { ViewKind } from '../../src/shared/messages.js'
import { monitorWith } from '../../src/shared/monitors.js'
import {
  idle,
  pause,
  renderer,
  replaying,
  simpleDialog,
  testHost,
  until,
  VM,
} from '../e2e/harness.js'

/** Cases by bus count; compare.mjs reports time per bus across them. */
const CASES = [
  ['cases/IEEE39.case.json', 39],
  ['cases/WECC240.case.json', 243],
  ['cases/ACTIVSg2000.case.json', 2000],
  ['cases/ACTIVSg10k.case.json', 10000],
] as const
const RUNS = 5
const EXPORTS = 3
/** Cumulative counters, compared per run. */
const WORK = [
  'uploaded',
  'uploads',
  'written',
  'evaluated',
  'resolved',
  'cleared',
  'packed',
  'readbacks',
  'jobs',
  'texts',
  'pipelines',
  'late',
] as const
/** Per-frame gauges, compared as is. */
const SIZE = ['draws', 'instances', 'rows', 'drawn', 'resident', 'uploading'] as const
type Stats = Record<(typeof SIZE)[number] | 'frames', number> & {
  work: Record<(typeof WORK)[number], number>
}
type Plot = { frames: number; at?: number; instances: number; complete: boolean; visible: boolean }
/** Keeps work independent of timing: no easing or motion (VS Code's reduceMotion is set too). */
const STILL = {
  'network.transitionDuration': 0,
  'network.labels': true,
  'network.motion': 'reduced',
}
const RUN = { tmax: 1, dt_monitor: 0.01, events: [] }
const PLAYBACK_MS = 3000
/** Seek targets as fractions of the run. */
const SEEKS = [0.9, 0.1, 0.6, 0.3, 0.75]

const timings: Record<string, number[]> = {}
const work: Record<string, Record<string, number>> = {}

/** Times a fixed workload to gauge machine speed; compare.mjs skips cases whose canary ran slow. */
function canary(): number {
  const start = performance.now()
  let sink = 0
  for (let i = 0; i < 2e7; i++) sink += Math.sqrt(i)
  return performance.now() - start + (sink < 0 ? 1 : 0)
}

/** Polls `check` every few milliseconds so the polling adds little to the measured time. */
async function settle(check: () => unknown, label: string, timeout = 60_000): Promise<void> {
  const start = performance.now()
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error('Timed out: ' + label)
    await pause(4)
  }
}

/** Times `act` through `done`, `runs` times; `ready` runs untimed and its result goes to both. */
async function time<T = void>(
  name: string,
  runs: number,
  steps: {
    ready?: (i: number) => Promise<T>
    act: (i: number, found: T) => unknown
    done: (i: number, found: T) => Promise<unknown>
  },
): Promise<void> {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const found = (await steps.ready?.(i)) as T
    const start = performance.now()
    await steps.act(i, found)
    await steps.done(i, found)
    samples.push(performance.now() - start)
  }
  timings[name] = samples
}

/** Resolves once `frame`'s canvas has drawn more than `frames` frames. */
const painted = (frame: Frame, frames: number) =>
  frame.waitForFunction('(frames) => gridkitStats().frames > frames', frames, {
    polling: 'raf',
    timeout: 60_000,
  })

const plots = (monitor: Frame) =>
  monitor.evaluate<Plot[]>(`Array.from(document.querySelectorAll('canvas')).map((canvas) => {
    const plot = canvas.gridkitPlot?.()
    const r = canvas.getBoundingClientRect()
    return plot && { frames: plot.frames, at: plot.at, instances: plot.instances,
      complete: plot.complete, visible: r.bottom > 0 && r.top < innerHeight }
  }).filter(Boolean)`)

/** Waits until every plot is complete and their instance counts stop changing. */
async function steady(monitor: Frame): Promise<Plot[]> {
  let before = await plots(monitor)
  const deadline = performance.now() + 60_000
  for (;;) {
    await pause(500)
    const now = await plots(monitor)
    if (
      now.every((plot) => plot.complete) &&
      now.map((plot) => plot.instances).join() === before.map((plot) => plot.instances).join()
    )
      return now
    if (performance.now() > deadline)
      throw new Error('Plots did not settle: ' + JSON.stringify(now))
    before = now
  }
}

/** Resolves once every visible plot has drawn past its count in `before`. */
const plotted = (monitor: Frame, before: readonly Plot[]) =>
  monitor.waitForFunction(
    `(before) => Array.from(document.querySelectorAll('canvas')).every((canvas, i) => {
      const r = canvas.getBoundingClientRect()
      return r.bottom <= 0 || r.top >= innerHeight || (canvas.gridkitPlot?.().frames ?? 0) > (before[i]?.frames ?? 0)
    })`,
    before,
    { polling: 'raf', timeout: 60_000 },
  )

const countMessages = (frame: Frame) =>
  frame.evaluate(`(() => {
    window.gridkitMessages = {}
    addEventListener('message', (event) => {
      const kind = event.data?.kind
      if (kind) window.gridkitMessages[kind] = (window.gridkitMessages[kind] ?? 0) + 1
    })
  })()`)
const messageCounts = (frame: Frame) =>
  frame.evaluate<Record<string, number>>('window.gridkitMessages')

export async function run() {
  const bench = await testHost()
  /** The panel view `kind` once it shows `selector`, so a page still unloading is not taken. */
  const viewShowing = (kind: ViewKind, selector: string) =>
    until(
      async () => {
        const frame = await bench.view(kind)
        return (await frame
          .locator(selector)
          .first()
          .isVisible()
          .catch(() => false))
          ? frame
          : undefined
      },
      `${kind} shows ${selector}`,
      60_000,
    )
  const settings = vscode.workspace.getConfiguration('gridkitStudio')
  const global = vscode.ConfigurationTarget.Global
  for (const [key, value] of Object.entries(STILL)) await settings.update(key, value, global)
  const workbench = vscode.workspace.getConfiguration('workbench')
  await workbench.update('reduceMotion', 'on', global)
  const gridkit = await bench.gridkit()
  /** compare.mjs only compares runs on the same GridKit build. */
  const build = gridkit ? await bench.gridkitBuild() : undefined
  await simpleDialog(true)
  try {
    for (const [path, buses] of CASES) {
      console.log(`Benchmarking ${path}`)
      const size = `${buses} buses`
      let network!: Frame
      let uri!: vscode.Uri
      const canaries = (timings[`machine ${size} > canary`] = [canary()])

      // ── Network ──
      const firstFrames: number[] = []
      const pageFirstFrames: number[] = []
      for (let i = 0; i < RUNS; i++) {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        const start = performance.now()
        ;({ uri, network } = await bench.openCase(path))
        firstFrames.push(performance.now() - start)
        pageFirstFrames.push(
          await network.evaluate<number>(
            "performance.getEntriesByName('canvas:frame')[0].startTime - performance.getEntriesByName('canvas:boot')[0].startTime",
          ),
        )
      }
      const key = uri.toString()
      const session = bench.studio.get(key)!
      const summary = () => bench.studio.state(key).summary!
      // From the command until the view settles, and from page boot to the page's own first frame.
      timings[`network ${size} > first frame`] = firstFrames
      timings[`network ${size} > first frame (page)`] = pageFirstFrames

      /** Times `act` to the network's next frame and records the average work per run. */
      async function measure(scenario: string, act: (i: number) => unknown) {
        const first = await idle<Stats>(network)
        const samples: number[] = []
        for (let i = 0; i < RUNS; i++) {
          const { frames } = await idle<Stats>(network)
          const start = performance.now()
          await act(i)
          await painted(network, frames)
          samples.push(performance.now() - start)
        }
        const last = await idle<Stats>(network)
        timings[`network ${size} > ${scenario}`] = samples
        work[`network ${size} > ${scenario}`] = Object.fromEntries([
          ...WORK.map((counter) => [
            counter,
            Math.round((last.work[counter] - first.work[counter]) / RUNS),
          ]),
          ...SIZE.map((counter) => [counter, last[counter]]),
        ])
      }
      const field = { table: 'Bus', field: 'init.Vr' }
      await measure('restyle', (i) =>
        bench.studio.get(key)!.map(field, i % 2 ? [] : ['vertexColor']),
      )
      await measure('camera move', async (i) => {
        await network.locator('canvas').hover()
        await bench.page.mouse.wheel(0, i % 2 ? 240 : -240)
      })
      await measure('labels', (i) => settings.update('network.labels', i % 2 === 1, global))
      await settings.update('network.labels', true, global)
      // The map draws only under a geographic case, the one kind Globe is enabled for.
      if (await network.getByRole('button', { name: 'Globe', exact: true }).isEnabled()) {
        await measure('map', (i) =>
          settings.update('map.basemap', i % 2 === 1 ? 'naturalEarth' : 'none', global),
        )
        await settings.update('map.basemap', undefined, global)
        await network.waitForFunction('() => gridkitStats().complete', undefined, {
          timeout: 60_000,
        })
      }
      const bus = JSON.parse(await readFile(uri.fsPath, 'utf8')).buses[0].number
      await measure('select', (i) =>
        bench.studio.get(key)!.select(i % 2 ? undefined : { table: 'Bus', id: bus }),
      )
      bench.studio.get(key)!.select()

      // An external edit to the case file, timed until the Network draws the reread case.
      const file = await readFile(uri.fsPath, 'utf8')
      const voltage = JSON.parse(file).buses[0].init.Vr as number
      const withVoltage = (value: number) =>
        file.replace(/("Vr":\s*)-?\d+(\.\d+)?([eE][-+]?\d+)?/, `$1${value}`)
      let read = summary().version
      await time(`network ${size} > file changed`, RUNS, {
        ready: async () => {
          read = summary().version
          return (await idle<Stats>(network)).frames
        },
        act: (i) =>
          vscode.workspace.fs.writeFile(
            uri,
            new TextEncoder().encode(withVoltage(voltage + (i + 1) * 0.001)),
          ),
        done: async (_, before) => {
          await settle(
            () => !bench.studio.state(key).stale && summary().version !== read,
            'the change read',
          )
          await network.waitForFunction(
            `([version, before]) => gridkitLifecycle().summary === version && gridkitStats().complete && gridkitStats().frames > before`,
            [summary().version, before],
            { timeout: 60_000 },
          )
        },
      })
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(file))
      await bench.studio.files.read(key)
      await settle(() => !bench.studio.state(key).stale, path + ' reads as written')

      // ── Case panel ──
      const counts = summary().counts
      const rows = (count: number) => `table[aria-rowcount="${count + 1}"]`
      // The panel's page is disposed when hidden, so each open loads it again.
      let table!: Frame
      await time(`case ${size} > open`, RUNS, {
        ready: async () => {
          await vscode.commands.executeCommand('workbench.action.closePanel')
          await pause(300)
        },
        act: () => vscode.commands.executeCommand('gridkitStudio.openCasePanel', uri),
        done: async () => (table = await viewShowing('case', rows(counts.Bus!))),
      })
      // Switch between Bus and the next largest type.
      const [other] = Object.entries(counts)
        .filter(([type]) => type !== 'Bus')
        .sort((a, b) => b[1] - a[1])
      const choose = (type: string) => bench.studio.get(key)!.setTable({ type })
      if (other)
        await time(`case ${size} > change type`, 2 * RUNS, {
          act: (i) => choose(i % 2 ? 'Bus' : other[0]),
          done: (i) =>
            table.locator(rows(i % 2 ? counts.Bus! : other[1])).waitFor({ timeout: 60_000 }),
        })
      await time(`case ${size} > filter`, 2 * RUNS, {
        act: (i) =>
          bench.studio.get(key)!.setTable({ filter: i % 2 ? undefined : 'no name holds this' }),
        done: (i) => table.locator(rows(i % 2 ? counts.Bus! : 0)).waitFor({ timeout: 60_000 }),
      })
      await table.locator('.cell').first().focus()
      await time(`case ${size} > page`, 2 * RUNS, {
        act: (i) => table.locator('.cell:focus').press(i % 2 ? 'Control+Home' : 'Control+End'),
        done: (i) =>
          table.locator(`.cell[data-row="${i % 2 ? 0 : counts.Bus! - 1}"]:focus`).waitFor(),
      })

      if (!gridkit) continue

      // ── One second of live simulation ──
      await bench.record('Bus', ['Vm'], uri)
      const solver = await bench.writeSolver(RUN, uri)
      session.showMonitor(VM)
      session.map(VM, ['vertexColor'])
      await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
      // Wait for this case's empty Monitor, not the previous case's.
      const monitor = await viewShowing('monitor', '.monitor .c-empty')
      await countMessages(network)
      await countMessages(monitor)
      const previous = session.run?.id
      const thisRun = () => (session.run?.id !== previous ? session.run : undefined)
      /** The case had no results before, so any shown since the run began are this run's. */
      const runResults = () => (thisRun() ? session.results : undefined)
      const started = performance.now()
      const since = () => performance.now() - started
      bench.explorer('Run Dynamic Simulation', solver)
      const [sampled, mapped, plottedLive] = await Promise.all([
        settle(() => (runResults()?.frames ?? 0) > 0, 'the first sample', 300_000).then(since),
        network
          .waitForFunction(
            '() => gridkitStats()?.complete && gridkitStats()?.covered && gridkitStats()?.windows.some(window => window.span?.length)',
            undefined,
            {
              polling: 'raf',
              timeout: 300_000,
            },
          )
          .then(since),
        monitor
          .locator('canvas[data-rendered=true]')
          .first()
          .waitFor({ timeout: 300_000 })
          .then(since),
      ])
      await settle(() => thisRun() && thisRun()!.state !== 'running', 'the run ends', 600_000)

      const ended = since()
      assert.equal(session.run?.state, 'complete', session.run?.message)
      timings[`simulation ${size} > first sample`] = [sampled]
      timings[`simulation ${size} > network shows a sample`] = [mapped]
      timings[`simulation ${size} > monitor shows a sample`] = [plottedLive]
      timings[`simulation ${size} > simulate 1 s`] = [ended]
      for (const [view, frame] of [
        ['network', network],
        ['monitor', monitor],
      ] as const)
        work[`simulation ${size} > ${view} messages`] = await messageCounts(frame)

      canaries.push(canary())

      // ── Playback ──
      const { transport } = session
      const span = session.results!.domain
      await steady(monitor)
      // The run is shorter than the measured time, so it replays when it ends.
      const replay = replaying(bench.studio, session)
      /** Mean time between frames each view presents while playing. */
      async function playback(scenario: string) {
        transport.seek(span[0])
        const before = {
          network: (await idle<Stats>(network)).frames,
          monitor: await plots(monitor),
        }
        const start = performance.now()
        transport.play()
        await pause(PLAYBACK_MS)
        const after = (await network.evaluate<Stats>('gridkitStats()')).frames
        const lanes = await plots(monitor)
        const playing = performance.now() - start
        transport.pause()
        timings[`playback ${size} > network ${scenario}`] = [playing / (after - before.network)]
        timings[`playback ${size} > monitor ${scenario}`] = [
          playing / Math.max(1, lanes[0]!.frames - before.monitor[0]!.frames),
        ]
      }
      await playback('frame')
      // A selected bus is highlighted in the Network and fades the other traces in the Monitor.
      bench.studio.get(key)!.select({ table: 'Bus', id: bus })
      await steady(monitor)
      await playback('frame, selected')
      replay.dispose()
      bench.studio.get(key)!.select()
      const at = (i: number) => span[0] + SEEKS[i]! * (span[1] - span[0])
      await time(`playback ${size} > seek`, SEEKS.length, {
        ready: async () => ({
          network: (await network.evaluate<Stats>('gridkitStats()')).frames,
          plots: await plots(monitor),
        }),
        act: (i) => transport.seek(at(i)),
        done: async (i, before) => {
          await network.waitForFunction(
            `([t, frames]) => gridkitStats().frames > frames && gridkitStats().covered && gridkitStats().complete && Math.abs(gridkitStats().at - t) < 1e-6`,
            [at(i), before.network],
            { polling: 'raf', timeout: 60_000 },
          )
          await plotted(monitor, before.plots)
          await monitor.waitForFunction(
            `(t) => Array.from(document.querySelectorAll('canvas')).every((c) => Math.abs((c.gridkitPlot?.().at ?? -1) - t) < 1e-6)`,
            at(i),
            { polling: 'raf', timeout: 60_000 },
          )
        },
      })
      await time(`playback ${size} > step`, RUNS, {
        ready: async () => transport.currentT(),
        act: () => vscode.commands.executeCommand('gridkitStudio.nextSample'),
        done: (_, from) => settle(() => transport.currentT() > from, 'a step'),
      })

      // ── Monitor ──
      const first = bus
      const element = (id?: number) => session.setMonitor(monitorWith(VM, id, undefined))
      // A new element replaces the plot; the old canvas is marked so the new one is recognized.
      const mark = () => monitor.evaluate(`document.querySelector('canvas').dataset.replaced = ''`)
      const replaced = () =>
        monitor.waitForFunction(
          `() => { const canvas = document.querySelector('canvas'); return !!canvas && !('replaced' in canvas.dataset) && !!canvas.gridkitPlot?.().complete }`,
          undefined,
          { polling: 'raf', timeout: 60_000 },
        )
      // Each sample narrows the monitor to one bus, after widening it to every bus untimed.
      await time(`monitor ${size} > choose element`, RUNS, {
        ready: async () => {
          if (session.shown[0]?.id !== undefined) {
            await mark()
            element(undefined)
            await replaced()
          }
          await mark()
        },
        act: () => element(first),
        done: () => replaced(),
      })
      await steady(monitor)
      await time(`monitor ${size} > line width`, RUNS, {
        ready: () => plots(monitor),
        act: (i) => settings.update('monitor.lineWidth', i % 2 ? 1 : 2, global),
        done: (_, lanes) => plotted(monitor, lanes),
      })
      await settings.update('monitor.lineWidth', undefined, global)
      const t = span[0] + 0.5 * (span[1] - span[0])
      const exact = await bench.studio.client.worker.call('sample', {
        results: session.results!.id,
        table: 'Bus',
        field: 'Vm',
        id: first,
        at: t,
      })
      assert.ok(exact && exact.value !== null)
      const value = exact.value
      await until(
        () =>
          monitor.evaluate<boolean>('document.querySelector("canvas")?.gridkitPlot?.().complete'),
        'the plot of one bus completes',
      )
      const point = await monitor.evaluate<[number, number]>(
        `document.querySelector('canvas').gridkitPoint(${t}, ${value})`,
      )
      timings[`monitor ${size} > pick`] = await monitor.evaluate<number[]>(`(async () => {
        const canvas = document.querySelectorAll('canvas')[0]
        const times = []
        for (let i = 0; i < ${RUNS}; i++) {
          const start = performance.now()
          await canvas.gridkitRead([${point[0]} + i, ${point[1]}])
          times.push(performance.now() - start)
        }
        return times
      })()`)
      await time(`monitor ${size} > select`, RUNS, {
        ready: async () => {
          bench.studio.get(key)!.select()
          await settle(() => session.selection === undefined, 'nothing selected')
        },
        act: () =>
          monitor
            .locator('canvas')
            .first()
            .click({ position: { x: point[0], y: point[1] } }),
        done: () => settle(() => session.selection?.id === first, 'the trace selected'),
      })

      canaries.push(canary())

      // ── Video export ──
      await vscode.commands.executeCommand('gridkitStudio.exportVideo', uri)
      const exporter = await viewShowing(
        'export',
        '[data-testid="export-start"]:not([aria-disabled="true"])',
      )
      for (const [name, on] of [
        ['Network', true],
        ['Monitor', false],
      ] as const) {
        const toggle = exporter.getByRole('switch', { name, exact: true })
        if (
          (await toggle.count()) &&
          ((await toggle.getAttribute('aria-checked')) === 'true') !== on
        )
          await toggle.click()
      }
      await exporter.getByLabel('Size', { exact: true }).selectOption({ label: '720p' })
      // Each export writes its own file, timed from choosing the file to the finished video.
      const video = (i: number) => vscode.Uri.joinPath(uri, '..', `bench ${buses} ${i}.mp4`)
      await time(`export ${size} > network 1 s at 720p`, EXPORTS, {
        ready: async (i) => {
          await rm(video(i).fsPath, { force: true })
          await exporter.locator('[data-testid="export-start"]').click()
          await bench.dialog(video(i).fsPath)
        },
        act: () => {},
        done: (i) =>
          until(
            async () =>
              !(await exporter.evaluate<boolean>('gridkitExport().running')) &&
              (await stat(video(i).fsPath).then(
                () => true,
                () => false,
              )),
            'the video written',
            300_000,
          ),
      })
      work[`export ${size} > network 1 s at 720p`] = {
        bytes: (await stat(video(EXPORTS - 1).fsPath)).size,
      }
      bench.studio.get(key)!.select()
    }
    const output = join(process.env.GRIDKIT_TEST_OUTPUT!, 'bench')
    await mkdir(output, { recursive: true })
    await writeFile(
      join(output, 'head.json'),
      JSON.stringify({ renderer: await renderer(), gridkit: build, timings, work }, null, 2),
    )
    console.log(`Benchmarks: ${Object.keys(timings).length} timed, written to ${output}`)
    assert.deepEqual(bench.studio.reporter.errors, [], 'Studio reported no error')
  } finally {
    await simpleDialog(undefined)
    for (const key of [...Object.keys(STILL), 'network.labels', 'map.basemap'])
      await settings.update(key, undefined, global)
    await workbench.update('reduceMotion', undefined, global)
    await bench.finish()
  }
}
