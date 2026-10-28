/** GridKit's DynamicSimulation, run as Studio runs it: on a solver file, in its folder, with the case
 *  it names beside it. GRIDKIT_PATH names an install, else the one on PATH, else Studio's default
 *  image or GRIDKIT_IMAGE runs in Docker or Podman. */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { applyEdits, modify } from 'jsonc-parser'
import type { Id } from 'latkit'
import { beforeAll, describe, expect, it } from 'vitest'

import manifest from '../../package.json'
import { apply } from '../../src/gridkit/edits.js'
import {
  available,
  Case,
  catalog,
  diagnose,
  PROGRAM,
  recordingOf,
  simulate,
} from '../../src/gridkit/index.js'
import { recordEdits } from '../../src/gridkit/recording.js'
import type { Runtime } from '../../src/gridkit/runtime.js'
import { ResultCache, type ResultsFile, Stores } from '../../src/results/index.js'
import type { TimeRange } from '../../src/shared/data.js'
import type { GridKit, RunRequest, RuntimeProcess } from '../../src/shared/messages.js'
import { outputOf, readSolver } from '../../src/shared/study.js'

/** Room for every chunk a run reads. */
const ROOM = 1 << 20

const gridkit: GridKit = {
  program: PROGRAM,
  path: process.env.GRIDKIT_PATH ?? '',
  image:
    process.env.GRIDKIT_IMAGE ??
    (
      manifest.contributes.configuration[0]!.properties['gridkitStudio.gridkitImage'] as {
        default: string
      }
    ).default,
  cli: process.env.GRIDKIT_CONTAINER_CLI ?? '',
}

/** A fault on the case's first BusFault from 0.05 s to 0.1 s, as GridKit's events name it. */
const FAULT = [
  { time: 0.05, type: 'fault_on', element_id: 0 },
  { time: 0.1, type: 'fault_off', element_id: 0 },
]

describe("GridKit's programs on solver files", () => {
  let root: string
  let runtime: Runtime
  /** Where the runs' results are kept, as a worker keeps them. */
  let stores: Stores
  const keeping = () => ({ cache: new ResultCache(ROOM), stores })

  beforeAll(async () => {
    await mkdir('output/simulation', { recursive: true })
    root = resolve(await mkdtemp('output/simulation/run-'))
    stores = new Stores(join(root, 'stores'))
    console.log('Simulation folders:', root)
    // Without GridKit there is nothing to test, and that is a failure said once.
    runtime = await available(gridkit)
    console.log('GridKit runs', runtime)
  })

  /** A case's buses in file order, which are the rows Studio reads them back as. */
  async function busesOf(name: string) {
    const text = await readFile(`cases/${name}.case.json`, 'utf8')
    return (JSON.parse(text) as { buses: { number: number; init: { Vr: number; Vi: number } }[] })
      .buses
  }

  /** Runs DynamicSimulation on a solver file written into a folder of its own, `name`, beside a copy
   *  of case `model` whose `mon` lists `record` writes. Reads the output where the solver file and
   *  the case say, as Studio does, until the run ends or `signal` aborts. `progress` hears of each
   *  run of frames read, and may stop the run. */
  async function run(
    name: string,
    model: string,
    solver: Record<string, unknown>,
    signal: AbortSignal,
    {
      record = (kase: Case, text: string) =>
        apply(text, recordEdits(kase, [{ type: 'Bus', add: ['Vm'], remove: [] }])),
      progress = () => {},
      using = gridkit,
      mount = root,
    }: {
      record?: (kase: Case, text: string) => string
      progress?: (stop: (reason: Error) => void) => void
      using?: GridKit
      mount?: string
    } = {},
  ) {
    const folder = join(root, name)
    await mkdir(folder)
    const release = await readFile(`cases/${model}.case.json`, 'utf8')
    const text = record(await Case.parse(release, catalog), release)
    const casePath = join(folder, `${model}.case.json`)
    await writeFile(casePath, text)
    const solverPath = join(folder, `${model}.solver.json`)
    const solverText = JSON.stringify({ system_model_file: `${model}.case.json`, ...solver })
    await writeFile(solverPath, solverText)
    const kase = await Case.parse(text, catalog, `${model}.case.json`)
    const study = readSolver(`${model}.solver.json`, solverText)
    const sink = outputOf(`${model}.solver.json`, study, (await recordingOf(kase)).monitor)
    const request: RunRequest = {
      uri: pathToFileURL(casePath).href,
      version: 1,
      fingerprint: kase.version,
      text,
      run: randomUUID(),
      results: randomUUID(),
      solver: solverPath,
      output: join(folder, sink.file),
      tmax: study.tmax,
      root: mount,
      gridkit: using,
    }
    let owned: RuntimeProcess | undefined
    let released = false
    /** The results file the run reads, once it begins to. */
    let read: ResultsFile | undefined
    const controller = new AbortController()
    const done = simulate(kase, request, keeping(), {
      signal: AbortSignal.any([signal, controller.signal]),
      reading: (file) => (read = file),
      progress: async () => progress((reason) => controller.abort(reason)),
      log: () => {},
      lifecycle: (process) => {
        if (process) owned = process
        else released = true
      },
    })
    return {
      kase,
      folder,
      request,
      done,
      owned: () => owned,
      released: () => released,
      read: () => read,
    }
  }

  /** What Studio reads back of `field` for each recorded bus over `window`. */
  async function readBack(results: ResultsFile, name: string, range: TimeRange | number) {
    const found: { id: Id; t: number; value: number | null }[] = []
    const field = results.fields.findIndex((field) => field.table === 'Bus' && field.field === name)
    const ids = results.fields[field]!.ids
    if (typeof range === 'number') {
      for (const id of ids) {
        const sample = await results.sample(
          { results: 'simulation', table: 'Bus', field: name, id, at: range },
          AbortSignal.any([]),
        )
        found.push({ id, t: sample.at, value: sample.value })
      }
    } else
      for (const index of results.store.raw) {
        if (index.end < range[0] || index.start > range[1]) continue
        const block = await results.store.readRaw(index, field)
        for (let t = 0; t < block.at.length; t++) {
          if (block.at[t]! < range[0] || block.at[t]! > range[1]) continue
          for (let row = 0; row < ids.length; row++) {
            const value = block.values[t * ids.length + row]!
            found.push({
              id: ids[row]!,
              t: block.at[t]!,
              value: Number.isFinite(value) ? value : null,
            })
          }
        }
      }
    return found
  }

  for (const name of ['IEEE39', 'TwoArea', 'WECC240'])
    it(`${name}: writes where its solver file says, from the case's power flow, and every sample reads back`, async ({
      signal,
    }) => {
      expect(
        await diagnose(await Case.read(`cases/${name}.case.json`, catalog), AbortSignal.any([])),
      ).toEqual([])
      const { folder, done, released } = await run(
        name,
        name,
        // A folder GridKit would not make itself.
        { output_file: 'output/out.csv', tmax: 0.1, dt_monitor: 0.01, events: [] },
        signal,
        {
          record: (kase, text) =>
            apply(text, recordEdits(kase, [{ type: 'Bus', add: ['Vm', 'Va'], remove: [] }])),
        },
      )
      const results = await done
      const info = { ...results.layout, ...results.progress }
      expect(released()).toBe(true)
      await access(join(folder, 'output', 'out.csv'))
      expect(info.domain[0]).toBe(0)
      expect(info.domain[1]).toBeCloseTo(0.1, 9)
      const initial = new Map(
        (await busesOf(name)).map(({ number, init }) => [
          number,
          {
            Vm: Math.hypot(init.Vr, init.Vi),
            Va: Math.atan2(init.Vi, init.Vr),
          },
        ]),
      )
      for (const field of ['Vm', 'Va'] as const) {
        // Every bus, at least once a monitor step, and every value a number.
        const samples = await readBack(results, field, info.domain)
        expect(new Set(samples.map(({ id }) => id)).size).toBe(initial.size)
        expect(samples.every(({ value }) => Number.isFinite(value))).toBe(true)
        const times = [...new Set(samples.map(({ t }) => t))].sort((a, b) => a - b)
        expect(times.every((t, i) => !i || t - times[i - 1]! <= 0.01 + 1e-9)).toBe(true)
        // Each bus starts where the case's power flow left it.
        const start = await readBack(results, field, 0)
        expect(start).toHaveLength(initial.size)
        for (const { id, value } of start)
          expect(value).toBeCloseTo(initial.get(Number(id))![field], 3)
      }
    })

  it('records what the case lists, and nothing it does not', async ({ signal }) => {
    const row = (await busesOf('IEEE39')).findIndex((bus) => bus.number === 2)
    const { done } = await run(
      'listed',
      'IEEE39',
      { output_file: 'out.csv', tmax: 0.1, dt_monitor: 0.01, events: [] },
      signal,
      {
        record: (kase, text) => {
          const cleared = apply(
            text,
            recordEdits(kase, [{ type: 'Bus', add: [], remove: ['Va', 'Vm'] }]),
          )
          return applyEdits(cleared, modify(cleared, ['buses', row, 'mon'], ['Va', 'Vm'], {}))
        },
      },
    )
    const results = await done
    const info = { ...results.layout, ...results.progress }
    for (const field of ['Va', 'Vm']) {
      const samples = await readBack(results, field, info.domain)
      expect(new Set(samples.map(({ id }) => id))).toEqual(new Set([2]))
    }
    // The case's own lists record on: its machines' speeds.
    expect(info.outputs.some(({ table }) => table !== 'Bus')).toBe(true)
  })

  it('sags the faulted bus while the fault lasts', async ({ signal }) => {
    const { kase, done } = await run(
      'fault',
      'IEEE39',
      { output_file: 'out.csv', tmax: 0.2, dt_monitor: 0.01, events: FAULT },
      signal,
    )
    const results = await done
    const info = { ...results.layout, ...results.progress }
    expect(info.domain[1]).toBeCloseTo(0.2, 9)
    const faults = kase.table('BusFault')
    const bus = kase.cell(faults, 'ports.bus', 0) as number
    const samples = (await readBack(results, 'Vm', info.domain)).filter(
      (sample) => sample.id === bus,
    )
    expect(samples.every(({ value }) => Number.isFinite(value))).toBe(true)
    const lowest = (from: number, to: number) =>
      Math.min(...samples.filter(({ t }) => t >= from && t <= to).map(({ value }) => value!))
    expect(lowest(0, 0.04)).toBeGreaterThan(0.9)
    expect(lowest(0.05, 0.1)).toBeLessThan(0.8)
  })

  it('never reads what the last run of a solver file wrote, and keeps it when a run does not start', async ({
    signal,
  }) => {
    const solver = { output_file: 'out.csv', dt_monitor: 0.01, events: [] }
    const first = await run('again', 'IEEE39', { ...solver, tmax: 0.1 }, signal)
    expect((await first.done).progress.domain[1]).toBeCloseTo(0.1, 9)
    // The same folder and output, read again by a shorter run.
    const folder = join(root, 'again')
    await writeFile(
      join(folder, 'IEEE39.solver.json'),
      JSON.stringify({ system_model_file: 'IEEE39.case.json', ...solver, tmax: 0.05 }),
    )
    const request = { ...first.request, tmax: 0.05 }
    const out = join(folder, 'out.csv')
    const written = await readFile(out, 'utf8')
    // A GridKit that is not there starts nothing, and the last run's file stays as it was.
    await expect(
      simulate(
        first.kase,
        {
          ...request,
          results: randomUUID(),
          gridkit: { ...gridkit, path: join(folder, 'missing'), image: '' },
        },
        keeping(),
        { signal, reading: () => {}, progress: () => {}, log: () => {} },
      ),
    ).rejects.toThrow(/GridKit Path/)
    expect(await readFile(out, 'utf8')).toBe(written)
    // Nor does one that is there but does not start, as a broken install's: Studio leaves the file
    // to GridKit, which never wrote over it. Elsewhere than Windows an executable that is not a
    // program runs as a shell script, so the broken one there names an interpreter that is gone.
    const broken = join(folder, 'broken')
    await mkdir(broken)
    await writeFile(
      join(broken, process.platform === 'win32' ? 'DynamicSimulation.exe' : 'DynamicSimulation'),
      process.platform === 'win32' ? 'not a program' : '#!/nonexistent/interpreter\n',
      { mode: 0o755 },
    )
    await expect(
      simulate(
        first.kase,
        { ...request, results: randomUUID(), gridkit: { ...gridkit, path: broken, image: '' } },
        keeping(),
        { signal, reading: () => {}, progress: () => {}, log: () => {} },
      ),
    ).rejects.toThrow(/did not start.*GridKit Path/)
    expect(await readFile(out, 'utf8')).toBe(written)
    const results = await simulate(first.kase, { ...request, results: randomUUID() }, keeping(), {
      signal,
      reading: () => {},
      progress: () => {},
      log: () => {},
    })
    expect(results.progress.domain[1]).toBeCloseTo(0.05, 9)
  })

  it('begins a run once the run writing its file has ended, and reads only its own frames', async ({
    signal,
  }) => {
    const solver = { output_file: 'out.csv', dt_monitor: 0.01, events: [] }
    let writing!: () => void
    const begun = new Promise<void>((resolve) => (writing = resolve))
    let stop!: (reason: Error) => void
    const first = await run('turns', 'IEEE39', { ...solver, tmax: 1000 }, signal, {
      progress: (stopFirst) => {
        stop = stopFirst
        writing()
      },
    })
    await begun
    // GridKit read the first run's solver file as it started; the second reads this one.
    await writeFile(
      join(first.folder, 'IEEE39.solver.json'),
      JSON.stringify({ system_model_file: 'IEEE39.case.json', ...solver, tmax: 0.05 }),
    )
    const order: string[] = []
    const second = simulate(
      first.kase,
      { ...first.request, run: randomUUID(), results: randomUUID(), tmax: 0.05 },
      keeping(),
      {
        signal,
        reading: () => order.push('second began'),
        progress: () => {},
        log: () => {},
      },
    )
    const ended = first.done.catch(() => order.push('first ended'))
    stop(new Error('Stopped by the test'))
    await ended
    const results = await second
    expect(order).toEqual(['first ended', 'second began'])
    expect(first.read()!.progress.frames).toBeGreaterThan(0)
    expect(results.progress.domain[1]).toBeCloseTo(0.05, 9)
  })

  it('reads what a stopped run wrote to its end, which then exports as GridKit wrote it', async ({
    signal,
  }) => {
    let writing!: () => void
    const begun = new Promise<void>((resolve) => (writing = resolve))
    let stop!: (reason: Error) => void
    const stopped = await run(
      'stopped',
      'IEEE39',
      { output_file: 'out.csv', dt_monitor: 0.01, tmax: 1000, events: [] },
      signal,
      {
        progress: (stopRun) => {
          stop = stopRun
          writing()
        },
      },
    )
    await begun
    stop(new Error('Stopped by the test'))
    await expect(stopped.done).rejects.toThrow('Stopped by the test')
    // Read through to what GridKit wrote before it stopped, not cut off where it was stopped.
    const results = stopped.read()!
    expect(results.progress.growing).toBe(false)
    expect(results.progress.error).toBeUndefined()
    const exported = join(stopped.folder, 'exported.csv')
    await results.exportCsv(exported)
    const copy = await readFile(exported, 'utf8')
    // GridKit's own file, but for a last row it may have been stopped partway through.
    expect((await readFile(join(stopped.folder, 'out.csv'), 'utf8')).startsWith(copy)).toBe(true)
    expect(copy.split('\n').length - 2).toBe(results.progress.frames)
  })

  it('says why GridKit could not finish, and runs again', async ({ signal }) => {
    const failed = await run(
      'failure',
      'IEEE39',
      { output_file: 'out.csv', tmax: 0.1, dt_monitor: 0.01, max_steps: 1, events: [] },
      signal,
    )
    const error = await failed.done.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message.trim()).not.toBe('')
    expect(failed.released()).toBe(true)
    const retry = await run(
      'retry',
      'IEEE39',
      { output_file: 'out.csv', tmax: 0.1, dt_monitor: 0.01, events: [] },
      signal,
    )
    expect((await retry.done).progress.domain[1]).toBeCloseTo(0.1, 9)
  })

  it('refuses an image this machine does not have, and never pulls it', async ({
    signal,
    skip,
  }) => {
    if (runtime.kind !== 'container') skip()
    const { cli } = runtime as Extract<Runtime, { kind: 'container' }>
    const image = 'ghcr.io/lukelowry/gridkit:studio-never-pulls'
    const { done, owned } = await run(
      'unpulled',
      'IEEE39',
      { output_file: 'out.csv', tmax: 0.1, events: [] },
      signal,
      { using: { ...gridkit, image } },
    )
    await expect(done).rejects.toThrow(image)
    expect(owned()).toBeUndefined()
    await expect(promisify(execFile)(cli, ['image', 'inspect', image])).rejects.toThrow()
  })

  it('keeps a container to the folder it mounts, before starting a process', async ({
    signal,
    skip,
  }) => {
    if (runtime.kind !== 'container') skip()
    const elsewhere = resolve(await mkdtemp('output/simulation/elsewhere-'))
    const { done, owned } = await run(
      'outside',
      'IEEE39',
      { output_file: 'out.csv', tmax: 0.1, events: [] },
      signal,
      { mount: elsewhere },
    )
    await expect(done).rejects.toThrow('outside')
    expect(owned()).toBeUndefined()
  })

  it('stops with its process when cancelled, keeping the frames it wrote', async ({ signal }) => {
    const { request, done, owned, released, read } = await run(
      'cancel',
      'IEEE39',
      { output_file: 'out.csv', tmax: 1000, dt_monitor: 0.001, events: [] },
      signal,
      { progress: (stop) => stop(new Error('Cancelled by the test')) },
    )
    await expect(done).rejects.toThrow('Cancelled by the test')
    expect(released()).toBe(true)
    expect(read()!.layout.path).toBe(request.output)
    expect(read()!.progress.frames).toBeGreaterThan(0)
    expect(read()!.progress.domain[1]).toBeLessThan(1000)
    // The process is gone, not left to finish its thousand seconds, and so is its container.
    expect(() => process.kill(owned()!.pid, 0)).toThrow()
    const container = owned()!.container
    if (container) {
      const { stdout } = await promisify(execFile)(container.cli, [
        'ps',
        '--all',
        '--quiet',
        '--filter',
        'name=' + container.name,
      ])
      expect(stdout.trim()).toBe('')
    }
  })
})
