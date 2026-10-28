/** Studio's benchmarks inside VS Code, case by case: how soon each view draws, and how soon it
 *  answers what the user does. Where GridKit runs, each case also runs a second of simulation,
 *  followed live, then played, scrubbed, stepped, plotted, restyled, picked and exported. Each
 *  scenario's times, and the work it did, are written for compare.mjs to set beside another run's.
 *  compare.mjs fails the migration gate when qualified timings regress. */

import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import type { ViewKind } from '../../src/shared/messages.js'
import {
  fills,
  idle,
  pause,
  replaying,
  simpleDialog,
  testHost,
  until,
  VM,
} from '../vscode/harness.js'

/** Cases by bus count; compare.mjs reports time per bus across them. */
const CASES = [
  ['cases/IEEE39.case.json', 39],
  ['cases/WECC240.case.json', 243],
  ['cases/ACTIVSg2000.case.json', 2000],
  ['cases/ACTIVSg10k.case.json', 10000],
] as const
const RUNS = 5
/** Exports per case, each a second of video. */
const EXPORTS = 3
/** Counters that only grow, compared per run. */
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
/** What the frame holds, compared as is. */
const SIZE = ['draws', 'instances', 'rows', 'drawn', 'resident', 'uploading'] as const
type Stats = Record<(typeof SIZE)[number] | 'frames', number> & {
  work: Record<(typeof WORK)[number], number>
}
/** A plot's counters, as its canvas reports them. */
type Plot = { frames: number; at?: number; instances: number; complete: boolean; visible: boolean }
/** Work must not depend on timing: no hover search, easing, or motion, which VS Code's own
 *  setting reduces. */
const STILL = { 'network.ease': 0, 'network.labels': true, 'network.motion': 'reduced' }
/** A second of simulation, its frames a hundredth of a second apart, as a solver file says it. */
const RUN = { tmax: 1, dt_monitor: 0.01, events: [] }
/** How long playback is timed. */
const PLAYBACK_MS = 3000
/** Where seeks land, as parts of the run. */
const SEEKS = [0.9, 0.1, 0.6, 0.3, 0.75]
/** How often the extension host's loop is looked at, in milliseconds, while a case changes. */
const BEAT_MS = 10

const timings: Record<string, number[]> = {}
const work: Record<string, Record<string, number>> = {}
const stages: Record<string, unknown> = {}

/** A fixed piece of work, timed: how fast the machine runs now, whatever Studio does. compare.mjs
 *  leaves out a case whose canary ran slow, as a busy machine slows everything it times. */
function canary(): number {
  const start = performance.now()
  let sink = 0
  for (let i = 0; i < 2e7; i++) sink += Math.sqrt(i)
  return performance.now() - start + (sink < 0 ? 1 : 0)
}

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
    return plot && { frames: plot.frames, at: plot.at, instances: plot.instances,
      complete: plot.complete, visible: r.bottom > 0 && r.top < innerHeight }
  }).filter(Boolean)`)

/** The plots once they draw nothing more: no line complete, none drawn again for a while, as
 *  after a lane's new size. */
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
  const workbench = vscode.workspace.getConfiguration('workbench')
  await workbench.update('reduceMotion', 'on', global)
  const gridkit = await bench.gridkit()
  /** The GridKit build the runs use, which compare.mjs matches between runs. */
  const build = gridkit ? await bench.gridkitBuild() : undefined
  await simpleDialog(true)
  try {
    for (const [path, buses] of CASES) {
      console.log(`Benchmarking ${path}`)
      const size = `${buses} buses`
      let network!: Frame
      let uri!: vscode.Uri
      // How fast the machine runs, timed again as the case goes on.
      const paced = (timings[`machine ${size} > canary`] = [canary()])

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
      const session = bench.studio.get(key)!
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
          ...WORK.map((counter) => [
            counter,
            Math.round((last.work[counter] - first.work[counter]) / RUNS),
          ]),
          ...SIZE.map((counter) => [counter, last[counter]]),
        ])
      }
      const field = { table: 'Bus', field: 'init.Vr' }
      await measure('restyle', (i) =>
        bench.studio.get(key)!.bind(field, i % 2 ? [] : ['vertexColor']),
      )
      await measure('camera move', async (i) => {
        await network.locator('canvas').hover()
        await bench.page.mouse.wheel(0, i % 2 ? 240 : -240)
      })
      await measure('labels', (i) => settings.update('network.labels', i % 2 === 1, global))
      await settings.update('network.labels', true, global)
      // The map draws only on Earth, after the first frame.
      if (await network.getByRole('button', { name: 'Globe', exact: true }).isEnabled()) {
        await measure('map', (i) =>
          settings.update('network.map.source', i % 2 === 1 ? 'borders' : 'none', global),
        )
        await settings.update('network.map.source', undefined, global)
        await network.waitForFunction('() => gridkitStats().complete', undefined, {
          timeout: 60_000,
        })
      }
      const bus = JSON.parse(await readFile(uri.fsPath, 'utf8')).buses[0].number
      // A selection draws again over the rest, glowing. Clearing it draws as before.
      await measure('select', (i) =>
        bench.studio.get(key)!.select(i % 2 ? undefined : { table: 'Bus', id: bus }),
      )
      bench.studio.get(key)!.select()

      const document = await vscode.workspace.openTextDocument(uri)
      const voltage = JSON.parse(document.getText()).buses[0].init.Vr as number
      await time(`network ${size} > scalar edit`, RUNS, {
        ready: async () => {
          await bench.studio.documents.ensure(document)
          return (await idle<Stats>(network)).frames
        },
        act: (i) =>
          bench.studio.documents.edit(
            key,
            document.version,
            { table: 'Bus', id: bus, field: 'init.Vr' },
            voltage + (i + 1) * 0.001,
          ),
        done: async (_, before) => {
          await network.waitForFunction(
            `([version, before]) => gridkitLifecycle().summary === version && gridkitStats().complete && gridkitStats().frames > before`,
            [document.version, before],
            { timeout: 60_000 },
          )
        },
      })
      await bench.studio.documents.ensure(document)
      await bench.studio.documents.edit(
        key,
        document.version,
        { table: 'Bus', id: bus, field: 'init.Vr' },
        voltage,
      )
      await bench.studio.documents.ensure(document)

      // ── Diagram ──
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'gridkitStudio.diagram',
        vscode.ViewColumn.Beside,
      )
      const opened = performance.now()
      const diagram = await bench.view('diagram')
      // A case with no directed signal components draws nothing.
      const drawn = await diagram
        .waitForFunction(
          `() => document.querySelector('canvas[data-rendered=true]') ? 'drawn' : document.querySelector('.canvas-host[data-empty]') ? 'none' : ''`,
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
      // The Diagram's tab closes by name, whichever editor has focus, and leaves the Network's.
      await vscode.window.tabGroups.close(
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .filter(
            (tab) =>
              tab.input instanceof vscode.TabInputCustom &&
              tab.input.viewType === 'gridkitStudio.diagram',
          ),
      )

      // ── Case panel ──
      const counts = summary().counts
      const rows = (count: number) => `table[aria-rowcount="${count + 1}"]`
      // The panel's page goes when it hides, so each open loads it anew. The page is found again
      // each look, as the panel takes up each case on a page of its own.
      let table!: Frame
      await time(`case ${size} > open`, RUNS, {
        ready: async () => {
          await vscode.commands.executeCommand('workbench.action.closePanel')
          await pause(300)
        },
        act: () => vscode.commands.executeCommand('gridkitStudio.openCasePanel', uri),
        done: async () => (table = await shows('case', rows(counts.Bus!))),
      })
      // The type with the most rows besides buses, and back.
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

      // ── Monitored Signals ──
      // Checking an output in Monitored Signals rewrites the list of each element of its type. A
      // release case writes each list over lines, and Studio writes it on one. Buses, and the type
      // with the most elements besides them that records anything, are checked first on lists as
      // the case writes them, then checked and unchecked on lists Studio wrote. Each change is
      // timed until the case reads it, beside the longest the extension host went between two
      // beats meanwhile, as every extension waited as long. Its work is the edits VS Code made.
      // These are timed last in each case, so that what such large edits leave behind slows
      // nothing else timed. The case as its file writes it is kept from here, before any run.
      const written = await readFile(uri.fsPath, 'utf8')
      const recording = JSON.stringify(summary().recording)
      /** Monitored Signals, timed, the case left as found and saved. */
      const recordings = async () => {
        const document = bench.studio.documents.get(key)!.document
        const outputs = (type: string) =>
          summary()
            .definition.tables.find((table) => table.name === type)!
            .fields.filter((field) => field.kind === 'sampled')
            .map((field) => field.name)
        const listed = (type: string, field: string) =>
          summary().recording.listed[type]?.[field] ?? 0
        /** The case as its file writes it, once read. */
        const asWritten = async () => {
          if (document.getText() === written) return
          const all = new vscode.WorkspaceEdit()
          all.replace(
            uri,
            document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)),
            written,
          )
          await vscode.workspace.applyEdit(all)
          await settle(
            () =>
              !bench.studio.state(key).stale && JSON.stringify(summary().recording) === recording,
            path + ' reads as written',
          )
        }
        let edits = 0
        let beat = performance.now()
        let stall = 0
        const listening = vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document === document) edits += event.contentChanges.length
        })
        const beating = setInterval(() => {
          const now = performance.now()
          stall = Math.max(stall, now - beat)
          beat = now
        }, BEAT_MS)
        try {
          // What a run had the case record is no longer what its file writes.
          await asWritten()
          const [busiest] = Object.entries(counts)
            .filter(([type]) => type !== 'Bus' && outputs(type).length)
            .sort((a, b) => b[1] - a[1])
          for (const type of ['Bus', ...(busiest ? [busiest[0]] : [])]) {
            const field = outputs(type).find((name) => !listed(type, name))
            if (!field) continue
            for (const [lists, runs, ready, on] of [
              ['as written', RUNS, asWritten, () => true],
              ['as Studio writes it', 2 * RUNS, async () => {}, (i: number) => i % 2 === 1],
            ] as const) {
              const name = `signals ${size} > ${type} ${lists}`
              const stalls: number[] = []
              let made = 0
              await time(name, runs, {
                ready: async () => {
                  await ready()
                  edits = 0
                  stall = 0
                  beat = performance.now()
                },
                act: (i) =>
                  bench.studio.documents.transact(
                    key,
                    'latest',
                    [
                      {
                        kind: 'record',
                        type,
                        add: on(i) ? [field] : [],
                        remove: on(i) ? [] : [field],
                      },
                    ],
                    'Change recorded signals',
                  ),
                done: async (i) => {
                  await settle(
                    () =>
                      !bench.studio.state(key).stale &&
                      listed(type, field) === (on(i) ? counts[type] : 0),
                    `${type} ${on(i) ? 'records' : 'stops recording'} ${field}`,
                  )
                  stalls.push(Math.max(stall, performance.now() - beat))
                  made += edits
                },
              })
              timings[`${name}, host stall`] = stalls
              work[name] = { edits: Math.round(made / runs) }
            }
          }
        } finally {
          clearInterval(beating)
          listening.dispose()
        }
        await asWritten()
        await document.save()
      }

      if (!gridkit) {
        await recordings()
        continue
      }

      // ── A second of simulation, followed live ──
      await bench.record('Bus', ['Vm'], uri)
      const solver = await bench.writeSolver(RUN, uri)
      session.setPlots([{ from: 'Bus', field: 'Vm' }])
      session.bind(VM, ['vertexColor'])
      await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
      // This case has no run yet, unlike the one before it.
      const monitor = await shows('monitor', '.monitor .c-empty')
      await listen(network)
      await listen(monitor)
      const previous = session.run?.id
      /** The run started here, once it shows. */
      const ran = () => (session.run?.id !== previous ? session.run : undefined)
      /** What the run started here wrote, as read so far: the case had no results on show, so any
       *  shown since the run began are its own. */
      const wrote = () => (ran() ? session.results : undefined)
      const started = performance.now()
      const since = () => performance.now() - started
      bench.run('Run Dynamic Simulation', solver)
      const [sampled, mapped, plottedLive] = await Promise.all([
        settle(() => (wrote()?.frames ?? 0) > 0, 'the first sample', 300_000).then(since),
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

      paced.push(canary())

      // ── Playback ──
      const { transport } = session
      const span = session.results!.domain
      await steady(monitor)
      // The run is shorter than the time measured, so it plays again each time it ends.
      const replay = replaying(bench.studio, session)
      /** The time between frames each view presents while playing: one display frame at best. */
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
      // A selected bus draws again over the rest in the Network, and fades the other traces in
      // the Monitor.
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

      // ── Plots ──
      const first = bus
      const alone = [...session.plots]
      const lanesBefore = (await plots(monitor)).length
      /** Until the Monitor draws `count` plots. */
      const lanes = (count: number) =>
        monitor.waitForFunction(
          `(count) => document.querySelectorAll('canvas[data-rendered=true]').length === count`,
          count,
          { polling: 'raf', timeout: 60_000 },
        )
      // Each sample adds the plot afresh: the one the sample before added goes first, untimed.
      await time(`monitor ${size} > add plot`, RUNS, {
        ready: async () => {
          if (session.plots.length === alone.length) return
          session.setPlots(alone)
          await lanes(lanesBefore)
        },
        act: () => session.setPlots([...alone, { from: 'Bus', field: 'Vm', id: first }]),
        done: () => lanes(lanesBefore + 1),
      })
      await steady(monitor)
      await time(`monitor ${size} > line width`, RUNS, {
        ready: () => plots(monitor),
        act: (i) => settings.update('monitor.lineWidth', i % 2 ? 1 : 2, global),
        done: (_, lanes) => plotted(monitor, lanes),
      })
      await settings.update('monitor.lineWidth', undefined, global)
      // The traces under the pointer, read where the plot drew them.
      const t = span[0] + 0.5 * (span[1] - span[0])
      const exact = await bench.studio.client.results.call('sample', {
        results: session.results!.id,
        table: 'Bus',
        field: 'Vm',
        id: first,
        at: t,
      })
      assert.ok(exact && exact.value !== null)
      const value = exact.value
      await monitor.locator('canvas').nth(1).scrollIntoViewIfNeeded()
      await until(
        () =>
          monitor.evaluate<boolean>(
            'document.querySelectorAll("canvas")[1]?.gridkitPlot?.().complete',
          ),
        'the target plot completes after scrolling',
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
      // Each sample selects the trace afresh, from nothing selected.
      await time(`monitor ${size} > select`, RUNS, {
        ready: async () => {
          bench.studio.get(key)!.select()
          await settle(() => session.selection === undefined, 'nothing selected')
        },
        act: () =>
          monitor
            .locator('canvas')
            .nth(1)
            .click({ position: { x: point[0], y: point[1] } }),
        done: () => settle(() => session.selection?.id === first, 'the trace selected'),
      })

      paced.push(canary())

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
      await exporter.locator('[data-testid="video-resolution"]').click()
      await exporter.locator('[role="option"][data-value="720"]').click()
      // Each export writes a file of its own, and is timed from the file chosen to the video done.
      const video = (i: number) => vscode.Uri.joinPath(uri, '..', `bench ${buses} ${i}.mp4`)
      await time(`export ${size} > network 1 s at 720p`, EXPORTS, {
        ready: async (i) => {
          await exporter.locator('[data-testid="video-start"]').click()
          await bench.dialog(video(i).fsPath)
        },
        act: () => {},
        done: (i) =>
          exporter
            .locator('[data-testid="video-done"]', { hasText: basename(video(i).fsPath) })
            .waitFor({ timeout: 300_000 }),
      })
      work[`export ${size} > network 1 s at 720p`] = {
        bytes: (await stat(video(EXPORTS - 1).fsPath)).size,
      }
      bench.studio.get(key)!.select()
      await recordings()
    }
    const output = join(process.env.GRIDKIT_TEST_OUTPUT!, 'bench')
    await mkdir(output, { recursive: true })
    await writeFile(
      join(output, 'head.json'),
      JSON.stringify({ renderer: 'latkit@0.3.1', gridkit: build, timings, work, stages }, null, 2),
    )
    console.log(`Benchmarks: ${Object.keys(timings).length} timed, written to ${output}`)
    assert.deepEqual(bench.studio.reporter.errors, [], 'Studio reported no error')
  } finally {
    await simpleDialog(undefined)
    for (const key of [...Object.keys(STILL), 'network.labels', 'network.map.source'])
      await settings.update(key, undefined, global)
    await workbench.update('reduceMotion', undefined, global)
    await bench.finish()
  }
}
