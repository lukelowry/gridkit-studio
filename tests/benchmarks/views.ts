/** Studio's benchmarks inside VS Code, case by case: how soon each view draws, and how soon it
 *  answers what the user does. Where GridKit runs, each case also runs a second of simulation,
 *  followed live, then played, scrubbed, stepped, plotted, recolored, picked and exported. Each
 *  scenario's times, and the work it did, are written for compare.mjs to set beside another run's.
 *  No time fails a run; it fails only when a view stops answering, or a recolor draws its lines
 *  again. */

import assert from 'node:assert/strict'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { rowsOf } from '../../src/shared/cells.js'
import type { ViewKind } from '../../src/shared/messages.js'
import { fills, idle, pause, simpleDialog, testHost, until, VM } from '../vscode/harness.js'

/** Cases by bus count; compare.mjs reports time per bus across them. */
const CASES = [
  ['cases/IEEE39.case.json', 39],
  ['cases/WECC240.case.json', 243],
  ['cases/ACTIVSg2000.case.json', 2000],
  ['cases/ACTIVSg10k.case.json', 10000],
] as const
const RUNS = 5
/** Counters that only grow, compared per run. */
const WORK = [
  'queries',
  'uploads',
  'uploadedBytes',
  'allocations',
  'submissions',
  'evictions',
] as const
/** What the frame holds, compared as is. */
const SIZE = ['drawCalls', 'segments', 'geometryBytes', 'pickingBytes'] as const
type Stats = Record<(typeof WORK)[number] | (typeof SIZE)[number] | 'frames', number>
/** A plot's counters, as its canvas reports them. */
type Plot = { frames: number; at?: number; segments: number; refining: boolean; visible: boolean }
/** Work must not depend on timing: no hover search, easing, or motion. */
const STILL = {
  'network.hover': 'off',
  'network.animationMs': 0,
  'accessibility.motion': 'reduce',
  // Pin the workload across changes to application defaults.
  'network.vertices.labels': true,
}
/** A second of simulation, its frames a hundredth of a second apart. */
const RUN = { tmax: 1, dt_monitor: 0.01 }
/** How long playback is timed. */
const PLAYBACK_MS = 3000
/** Where seeks land, as parts of the run. */
const SEEKS = [0.9, 0.1, 0.6, 0.3, 0.75]

const timings: Record<string, number[]> = {}
const work: Record<string, Record<string, number>> = {}
const stages: Record<string, unknown> = {}

/** Wait for `check` to hold, looking every few milliseconds so the time it takes is its own. */
async function settle(check: () => unknown, label: string, timeout = 60_000): Promise<void> {
  const start = performance.now()
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error('Timed out: ' + label)
    await pause(4)
  }
}

/** Time `act` until `done` resolves, `runs` times, as `name`. What `ready` finds first, untimed,
 *  is handed to both. */
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

/** Until `frame`'s canvas view draws a frame after its `frames`th. */
const painted = (frame: Frame, frames: number) =>
  frame.waitForFunction('(frames) => gridkitStats().frames > frames', frames, {
    polling: 'raf',
    timeout: 60_000,
  })

/** Each plot's counters, in lane order. */
const plots = (monitor: Frame) =>
  monitor.evaluate<Plot[]>(`Array.from(document.querySelectorAll('canvas')).map((canvas) => {
    const plot = canvas.gridkitPlot?.()
    const r = canvas.getBoundingClientRect()
    return plot && { frames: plot.frames, at: plot.at, segments: plot.segments,
      refining: plot.refining, visible: r.bottom > 0 && r.top < innerHeight }
  }).filter(Boolean)`)

/** The plots once they draw nothing more: no line refining, none drawn again for a while, as
 *  after a lane's new size. */
async function steady(monitor: Frame): Promise<Plot[]> {
  let before = await plots(monitor)
  for (;;) {
    await pause(500)
    const now = await plots(monitor)
    if (
      now.every((plot) => !plot.refining) &&
      now.map((plot) => plot.segments).join() === before.map((plot) => plot.segments).join()
    )
      return now
    before = now
  }
}

/** Until every plot on screen draws a frame after the one `before` counted. */
const plotted = (monitor: Frame, before: readonly Plot[]) =>
  monitor.waitForFunction(
    `(before) => Array.from(document.querySelectorAll('canvas')).every((canvas, i) => {
      const r = canvas.getBoundingClientRect()
      return r.bottom <= 0 || r.top >= innerHeight || (canvas.gridkitPlot?.().frames ?? 0) > (before[i]?.frames ?? 0)
    })`,
    before,
    { polling: 'raf', timeout: 60_000 },
  )

/** Count the messages a webview receives, by kind, from now on. */
const listen = (frame: Frame) =>
  frame.evaluate(`(() => {
    window.gridkitMessages = {}
    addEventListener('message', (event) => {
      const kind = event.data?.kind
      if (kind) window.gridkitMessages[kind] = (window.gridkitMessages[kind] ?? 0) + 1
    })
  })()`)
const heard = (frame: Frame) => frame.evaluate<Record<string, number>>('window.gridkitMessages')

export async function run() {
  const bench = await testHost()
  /** The page of panel view `kind` once it shows `selector`: the page of the case on show, where
   *  the one before it may still be loading away. */
  const shows = (kind: ViewKind, selector: string) =>
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
  const gridkit = await bench.gridkit()
  await simpleDialog(true)
  try {
    for (const [path, buses] of CASES) {
      console.log(`Benchmarking ${path}`)
      const size = `${buses} buses`
      let network!: Frame
      let uri!: vscode.Uri

      // ── Network ──
      const firsts: number[] = []
      const shown: number[] = []
      for (let i = 0; i < RUNS; i++) {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        const start = performance.now()
        ;({ uri, network } = await bench.openCase(path))
        firsts.push(performance.now() - start)
        shown.push(
          await network.evaluate<number>(
            "performance.getEntriesByName('canvas:frame')[0].startTime - performance.getEntriesByName('canvas:boot')[0].startTime",
          ),
        )
      }
      const key = uri.toString()
      const session = bench.studio.all.get(key)!
      const summary = () => bench.studio.state(key).summary!
      // Until the view settles, and until the page's own first frame: what the user sees first.
      timings[`network ${size} > first frame`] = firsts
      timings[`network ${size} > first frame (page)`] = shown
      assert.ok(await fills(network), path + ': the canvas fills its editor')
      stages[`network ${size}`] = await network.evaluate(
        'Object.fromEntries(performance.getEntriesByType("mark").map((e) => [e.name, e.startTime]))',
      )

      /** Time `act` to the network's next frame, and the work its runs did. */
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
          ...WORK.map((counter) => [counter, Math.round((last[counter] - first[counter]) / RUNS)]),
          ...SIZE.map((counter) => [counter, last[counter]]),
        ])
      }
      const field = { type: 'Bus', field: 'init.Vr' }
      await measure('restyle', (i) => bench.studio.bind(key, field, i % 2 ? [] : ['vertexColor']))
      await measure('camera move', async (i) => {
        await network.locator('canvas').hover()
        await bench.page.mouse.wheel(0, i % 2 ? 240 : -240)
      })
      await measure('labels', (i) =>
        settings.update('network.vertices.labels', i % 2 === 1, global),
      )
      await settings.update('network.vertices.labels', true, global)
      // Borders draw only on Earth, after the first frame.
      if (await network.getByRole('button', { name: 'Globe', exact: true }).isEnabled()) {
        await measure('borders', (i) => settings.update('network.borders', i % 2 === 1, global))
        const without = await idle<Stats>(network)
        await settings.update('network.borders', undefined, global)
        await network.waitForFunction(
          '(segments) => gridkitStats().segments > segments',
          without.segments,
          { timeout: 60_000 },
        )
      }

      // ── Diagram ──
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'gridkitStudio.diagram',
        vscode.ViewColumn.Beside,
      )
      const opened = performance.now()
      const diagram = await bench.view('diagram')
      // A case with no directed signal components says so instead of drawing.
      const drawn = await diagram
        .waitForFunction(
          `() => document.querySelector('canvas[data-rendered=true]') ? 'drawn' : /no directed signal/.test(document.body.innerText) ? 'none' : ''`,
          undefined,
          { polling: 'raf', timeout: 120_000 },
        )
        .then((answer) => answer.jsonValue())
      if (drawn === 'drawn') {
        timings[`diagram ${size} > first frame`] = [performance.now() - opened]
        await diagram.locator('canvas').hover()
        await time(`diagram ${size} > camera move`, RUNS, {
          ready: async () => (await idle(diagram)).frames,
          act: (i) => bench.page.mouse.wheel(0, i % 2 ? 240 : -240),
          done: (_, frames) => painted(diagram, frames),
        })
      }
      // The Diagram's editor is the active one: closing it leaves the Network's.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')

      // ── Case panel ──
      const counts = summary().counts
      const rows = (count: number) => `table[aria-rowcount="${count + 1}"]`
      let started = performance.now()
      await vscode.commands.executeCommand('gridkitStudio.openCasePanel', uri)
      // The panel takes up each case on a page of its own, so the page is found again each look.
      const table = await shows('case', rows(counts.Bus!))
      timings[`case ${size} > open`] = [performance.now() - started]
      // The type with the most rows besides buses, and back.
      const [other] = Object.entries(counts)
        .filter(([type]) => type !== 'Bus')
        .sort((a, b) => b[1] - a[1])
      const choose = (type: string) =>
        bench.studio.action.fire({ uri: key, view: 'case', command: 'type', value: type })
      if (other)
        await time(`case ${size} > change type`, 2, {
          act: (i) => choose(i % 2 ? 'Bus' : other[0]),
          done: (i) =>
            table.locator(rows(i % 2 ? counts.Bus! : other[1])).waitFor({ timeout: 60_000 }),
        })
      await time(`case ${size} > filter`, 2, {
        act: (i) =>
          bench.studio.action.fire({
            uri: key,
            view: 'case',
            command: 'filterText',
            value: i % 2 ? '' : 'no name holds this',
          }),
        done: (i) => table.locator(rows(i % 2 ? counts.Bus! : 0)).waitFor({ timeout: 60_000 }),
      })

      if (!gridkit) continue

      // ── A second of simulation, followed live ──
      bench.studio.record(key, [{ from: 'Bus', select: ['Vm'] }])
      session.values = RUN
      session.plots = [{ from: 'Bus', field: 'Vm' }]
      bench.studio.bind(key, VM, ['vertexColor'])
      await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
      // This case has no run yet, unlike the one before it.
      const monitor = await shows('monitor', '.monitor .c-empty')
      await listen(network)
      await listen(monitor)
      const previous = session.run?.id
      /** The stream the Network painted last: the run's samples come on a later one. */
      const unsampled = (await network.evaluate<{ stream?: number }>('gridkitStats()')).stream ?? 0
      /** The run started here, once it shows. */
      const ran = () => (session.run?.id !== previous ? session.run : undefined)
      started = performance.now()
      const since = () => performance.now() - started
      await vscode.commands.executeCommand('gridkitStudio.startSimulation', uri)
      const [sampled, mapped, plottedLive] = await Promise.all([
        settle(() => (ran()?.frames ?? 0) > 0, 'the first sample', 300_000).then(since),
        network
          .waitForFunction('(stream) => gridkitStats()?.stream > stream', unsampled, {
            polling: 'raf',
            timeout: 300_000,
          })
          .then(since),
        monitor
          .locator('canvas[data-rendered=true]')
          .first()
          .waitFor({ timeout: 300_000 })
          .then(since),
      ])
      await settle(() => ran() && ran()!.state !== 'running', 'the run ends', 600_000)

      const ended = since()
      assert.equal(session.run?.state, 'complete', session.run?.message)
      timings[`simulation ${size} > first sample`] = [sampled]
      timings[`simulation ${size} > network shows a sample`] = [mapped]
      timings[`simulation ${size} > monitor shows a sample`] = [plottedLive]
      timings[`simulation ${size} > simulate 1 s`] = [ended]
      // What each view was sent while the run streamed: the less, the less each did.
      for (const [view, frame] of [
        ['network', network],
        ['monitor', monitor],
      ] as const)
        work[`simulation ${size} > ${view} messages`] = await heard(frame)

      // ── Playback ──
      const { transport } = session
      const span = session.run!.domain
      await steady(monitor)
      transport.setLoop('wrap')
      transport.seek(span[0])
      const before = { network: (await idle<Stats>(network)).frames, monitor: await plots(monitor) }
      started = performance.now()
      transport.play()
      await pause(PLAYBACK_MS)
      const after = { network: (await network.evaluate<Stats>('gridkitStats()')).frames }
      const lanes = await plots(monitor)
      const playing = performance.now() - started
      transport.pause()
      // The time between frames each view presents while playing: one display frame at best.
      timings[`playback ${size} > network frame`] = [playing / (after.network - before.network)]
      timings[`playback ${size} > monitor frame`] = [
        playing / Math.max(1, lanes[0]!.frames - before.monitor[0]!.frames),
      ]
      const at = (i: number) => span[0] + SEEKS[i]! * (span[1] - span[0])
      await time(`playback ${size} > seek`, SEEKS.length, {
        act: (i) => transport.seek(at(i)),
        done: async (i) => {
          await network.waitForFunction(
            `(t) => gridkitStats().availability === 'ready' && Math.abs(gridkitStats().at - t) < 1e-6`,
            at(i),
            { polling: 'raf', timeout: 60_000 },
          )
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

      // ── Plots ──
      const [{ id: first }] = await bench.studio.client.call('elements', {
        uri: key,
        version: summary().version,
        type: 'Bus',
      })
      const lanesBefore = (await plots(monitor)).length
      await time(`monitor ${size} > add plot`, 1, {
        act: () => {
          session.plots = [...session.plots, { from: 'Bus', field: 'Vm', id: first! }]
          bench.studio.changed.fire(key)
        },
        done: () =>
          monitor.waitForFunction(
            `(count) => document.querySelectorAll('canvas[data-rendered=true]').length > count`,
            lanesBefore,
            { polling: 'raf', timeout: 60_000 },
          ),
      })
      // A new range colors the drawn lines again, and draws none of them.
      const recolored = await steady(monitor)
      const range = session.run!.domains!.Bus!.Vm!
      await time(`monitor ${size} > recolor`, RUNS, {
        ready: () => plots(monitor),
        act: (i) =>
          bench.studio.bind(key, VM, ['vertexColor'], [range[0] - i - 1, range[1] + i + 1]),
        done: (_, lanes) => plotted(monitor, lanes),
      })
      assert.deepEqual(
        (await plots(monitor)).map((plot) => plot.segments),
        recolored.map((plot) => plot.segments),
        'A recolor draws no line again',
      )
      // The traces under the pointer, read where the plot drew them.
      const t = span[0] + 0.5 * (span[1] - span[0])
      const value = Number(
        rowsOf(
          (
            await bench.studio.client.call('query', {
              uri: key,
              version: summary().version,
              run: session.run!.id,
              query: {
                kind: 'rows',
                from: 'Bus',
                select: ['Vm'],
                rows: { kind: 'ids', ids: [first] },
                at: t,
              },
            })
          ).filter((block) => block.kind === 'rows'),
        )[0]!.values.Vm,
      )
      const point = await monitor.evaluate<[number, number]>(
        `document.querySelectorAll('canvas')[1].gridkitPoint(${t}, ${value})`,
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
      await time(`monitor ${size} > select`, 1, {
        act: () =>
          monitor
            .locator('canvas')
            .nth(1)
            .click({ position: { x: point[0], y: point[1] } }),
        done: () => settle(() => session.selection?.id === first, 'the trace selected'),
      })

      // ── Video export ──
      await vscode.commands.executeCommand('gridkitStudio.exportVideo', uri)
      // This case's page offers to export its run, which none before it had exported.
      const exporter = await shows('export', '[data-testid="video-start"]:enabled')
      for (const [name, on] of [
        ['Network', true],
        ['Diagram', false],
        ['Monitor', false],
      ] as const) {
        const toggle = exporter.getByRole('switch', { name, exact: true })
        if (
          (await toggle.count()) &&
          ((await toggle.getAttribute('aria-checked')) === 'true') !== on
        )
          await toggle.click()
      }
      await exporter.locator('[data-testid="video-format"]').click()
      await exporter.locator('[role="option"][data-value="webm"]').click()
      await exporter.locator('[data-testid="video-resolution"]').click()
      await exporter.locator('[role="option"][data-value="720"]').click()
      const video = vscode.Uri.joinPath(uri, '..', `bench ${buses}.webm`)
      await exporter.locator('[data-testid="video-start"]').click()
      await bench.dialog(video.fsPath)
      started = performance.now()
      await exporter.locator('[data-testid="video-done"]').waitFor({ timeout: 300_000 })
      timings[`export ${size} > network 1 s at 720p`] = [performance.now() - started]
      work[`export ${size} > network 1 s at 720p`] = { bytes: (await stat(video.fsPath)).size }
      bench.studio.select(key)
    }
    const output = join(process.env.GRIDKIT_TEST_OUTPUT!, 'bench')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'head.json'), JSON.stringify({ timings, work, stages }, null, 2))
    console.log(`Benchmarks: ${Object.keys(timings).length} timed, written to ${output}`)
    assert.deepEqual(bench.studio.errors, [], 'Studio reported no error')
  } finally {
    await simpleDialog(undefined)
    for (const key of [...Object.keys(STILL), 'network.vertices.labels', 'network.borders'])
      await settings.update(key, undefined, global)
    await bench.browser.close()
  }
}
