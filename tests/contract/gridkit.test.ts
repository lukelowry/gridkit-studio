/** Runs the bundled solver by default; set GRIDKIT_PATH to test a native installation. */

import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { applyEdits, modify } from 'jsonc-parser'
import type { Id } from 'latkit'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  available,
  Case,
  catalog,
  diagnose,
  PROGRAM,
  recordingOf,
  simulate,
} from '../../src/gridkit/index.js'
import type { Runtime } from '../../src/gridkit/runtime.js'
import { type ResultsFile, Stores } from '../../src/results/index.js'
import type { TimeRange } from '../../src/shared/data.js'
import type { GridKit, RunRequest, RuntimeProcess } from '../../src/shared/messages.js'
import { outputOf, readSolver } from '../../src/shared/study.js'
import { withMons } from '../mons.js'

const gridkit: GridKit = {
  program: PROGRAM,
  path: process.env.GRIDKIT_PATH ?? '',
}

const wasm = {
  worker: resolve('dist/solver.mjs'),
  module: resolve('dist/solver/DynamicSimulation.mjs'),
  wasm: resolve('dist/solver/DynamicSimulation.wasm'),
}

const FAULTED = 16
const FAULT = [
  { time: 0.05, type: 'fault_on', bus: FAULTED, R: 0, X: 0.01 },
  { time: 0.1, type: 'fault_off', bus: FAULTED },
]

describe("GridKit's programs on solver files", () => {
  let root: string
  let runtime: Runtime
  let stores: Stores

  beforeAll(async () => {
    await mkdir('output/simulation', { recursive: true })
    root = resolve(await mkdtemp('output/simulation/run-'))
    stores = new Stores(join(root, 'stores'))
    console.log('Simulation folders:', root)
    // Missing GridKit fails the suite once, here.
    runtime = await available(gridkit)
    console.log('GridKit runs', runtime)
  })

  /** Adds `add` to every bus's `mon` list in the case `text`. */
  const listing = (text: string, add: readonly string[]) =>
    withMons(text, ({ type, mon }) =>
      type === 'Bus' ? [...mon.filter((name) => !add.includes(name)), ...add] : undefined,
    )

  /** A case's buses in file order, which is Studio's row order. */
  async function busesOf(name: string) {
    const text = await readFile(`cases/${name}.case.json`, 'utf8')
    return (JSON.parse(text) as { buses: { number: number; init: { Vr: number; Vi: number } }[] })
      .buses
  }

  /** Runs DynamicSimulation in folder `name` on a copy of `model` with `mon` lists from `record`,
   *  reading the output as Studio does. `progress` runs per batch of frames and may stop the run. */
  async function run(
    name: string,
    model: string,
    solver: Record<string, unknown>,
    signal: AbortSignal,
    {
      record = (text: string) => listing(text, ['Vm']),
      progress = () => {},
      using = gridkit,
    }: {
      record?: (text: string) => string
      progress?: (stop: (reason: Error) => void) => void
      using?: GridKit
    } = {},
  ) {
    const folder = join(root, name)
    await mkdir(folder)
    const original = await readFile(`cases/${model}.case.json`, 'utf8')
    const text = record(original)
    const casePath = join(folder, `${model}.case.json`)
    await writeFile(casePath, text)
    const solverPath = join(folder, `${model}.solver.json`)
    const solverText = JSON.stringify({ system_model_file: `${model}.case.json`, ...solver })
    await writeFile(solverPath, solverText)
    const kase = await Case.parse(new TextEncoder().encode(text), catalog, {
      name: `${model}.case.json`,
    })
    const study = readSolver(`${model}.solver.json`, solverText)
    const sink = outputOf(`${model}.solver.json`, study, (await recordingOf(kase)).monitor)
    const request: RunRequest = {
      uri: pathToFileURL(casePath).href,
      version: 1,
      run: randomUUID(),
      results: randomUUID(),
      solver: solverPath,
      output: join(folder, sink.file),
      tmax: study.tmax,
      gridkit: using,
    }
    let spawned: RuntimeProcess | undefined
    let released = false
    let resultsFile: ResultsFile | undefined
    const controller = new AbortController()
    const done = simulate(kase, request, stores, {
      wasm,
      signal: AbortSignal.any([signal, controller.signal]),
      reading: (file) => (resultsFile = file),
      progress: async () => progress((reason) => controller.abort(reason)),
      log: () => {},
      lifecycle: (process) => {
        if (process) spawned = process
        else released = true
      },
    })
    return {
      kase,
      folder,
      request,
      done,
      spawned: () => spawned,
      released: () => released,
      resultsFile: () => resultsFile,
    }
  }

  /** Reads back `name` for each recorded bus, over a time range or at one time. */
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
    } else {
      const rows = ids.map((_, row) => row)
      for (const index of results.store.raw) {
        if (index.end < range[0] || index.start > range[1]) continue
        const block = await results.store.readRaw(index, field, rows)
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
    }
    return found
  }

  for (const name of ['IEEE39', 'TwoArea', 'WECC240'])
    it(`${name}: writes where its solver file says, from the case's power flow, and every sample reads back`, async ({
      signal,
    }) => {
      expect(
        await diagnose(
          await Case.parse(await readFile(`cases/${name}.case.json`), catalog),
          AbortSignal.any([]),
        ),
      ).toEqual([])
      const { folder, done, released } = await run(
        name,
        name,
        // A folder GridKit would not create itself.
        { output_file: 'output/out.csv', tmax: 0.1, dt_monitor: 0.01, events: [] },
        signal,
        {
          record: (text) => listing(text, ['Vm', 'Va']),
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
        const samples = await readBack(results, field, info.domain)
        expect(new Set(samples.map(({ id }) => id)).size).toBe(initial.size)
        expect(samples.every(({ value }) => Number.isFinite(value))).toBe(true)
        const times = [...new Set(samples.map(({ t }) => t))].sort((a, b) => a - b)
        expect(times.every((t, i) => !i || t - times[i - 1]! <= 0.01 + 1e-9)).toBe(true)
        // Each bus starts at the case's power flow solution.
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
        // Only bus 2 records its voltage.
        record: (text) =>
          withMons(text, ({ type, index, mon }) =>
            type !== 'Bus'
              ? undefined
              : index === row
                ? ['Va', 'Vm']
                : mon.filter((name) => name !== 'Va' && name !== 'Vm'),
          ),
      },
    )
    const results = await done
    const info = { ...results.layout, ...results.progress }
    for (const field of ['Va', 'Vm']) {
      const samples = await readBack(results, field, info.domain)
      expect(new Set(samples.map(({ id }) => id))).toEqual(new Set([2]))
    }
    // The case's other lists still record, such as machine speeds.
    expect(info.outputs.some(({ table }) => table !== 'Bus')).toBe(true)
  })

  it('sags the faulted bus while the fault lasts', async ({ signal }) => {
    const { done } = await run(
      'fault',
      'IEEE39',
      { output_file: 'out.csv', tmax: 0.2, dt_monitor: 0.01, events: FAULT },
      signal,
    )
    const results = await done
    const info = { ...results.layout, ...results.progress }
    expect(info.domain[1]).toBeCloseTo(0.2, 9)
    const samples = (await readBack(results, 'Vm', info.domain)).filter(
      (sample) => sample.id === FAULTED,
    )
    expect(samples.every(({ value }) => Number.isFinite(value))).toBe(true)
    const lowest = (from: number, to: number) =>
      Math.min(...samples.filter(({ t }) => t >= from && t <= to).map(({ value }) => value!))
    expect(lowest(0, 0.04)).toBeGreaterThan(0.9)
    expect(lowest(0.05, 0.1)).toBeLessThan(0.8)
  })

  it('writes the case monitor in a folder with spaces and preserves the source files', async ({
    signal,
  }) => {
    const original = listing(await readFile('cases/IEEE39.case.json', 'utf8'), ['Vm'])
    const text = applyEdits(
      original,
      modify(
        original,
        ['monitors'],
        [{ format: 'csv', file_name: 'monitor data/voltage.csv' }],
        {},
      ),
    )
    const execution = await run(
      'monitor paths',
      'IEEE39',
      {
        tmax: 0.05,
        dt_monitor: 0.01,
        events: [],
      },
      signal,
      { record: () => text },
    )
    const study = await readFile(execution.request.solver, 'utf8')
    const result = await execution.done
    expect(result.progress.domain[1]).toBeCloseTo(0.05, 9)
    expect(await readFile(join(execution.folder, 'IEEE39.case.json'), 'utf8')).toBe(text)
    expect(await readFile(execution.request.solver, 'utf8')).toBe(study)
    await access(join(execution.folder, 'monitor data', 'voltage.csv'))
  })

  it('stages a reference file and reads the output back for comparison', async ({ signal }) => {
    const study = { output_file: 'out.csv', tmax: 0.05, dt_monitor: 0.01, events: [] }
    const reference = await run('reference', 'IEEE39', study, signal)
    await reference.done
    const bytes = await readFile(reference.request.output)
    const compared = await run(
      'compared',
      'IEEE39',
      {
        ...study,
        reference_file: reference.request.output,
        error_tolerance: 1e-8,
      },
      signal,
    )
    expect((await compared.done).progress.frames).toBeGreaterThan(0)
    expect(await readFile(reference.request.output)).toEqual(bytes)
  })

  it.skipIf(!!gridkit.path)(
    'accepts the same output in the study and case monitor',
    async ({ signal }) => {
      const execution = await run(
        'same monitor',
        'IEEE39',
        {
          output_file: 'out.csv',
          tmax: 0.05,
          dt_monitor: 0.01,
          events: [],
        },
        signal,
        {
          record: (text) =>
            applyEdits(
              listing(text, ['Vm']),
              modify(
                listing(text, ['Vm']),
                ['monitors'],
                [{ format: 'csv', file_name: 'out.csv' }],
                {},
              ),
            ),
        },
      )
      expect((await execution.done).progress.domain[1]).toBeCloseTo(0.05, 9)
    },
  )

  it.skipIf(!!gridkit.path)(
    'rejects unsupported state input without silently ignoring it',
    async ({ signal }) => {
      const execution = await run(
        'state input',
        'IEEE39',
        {
          output_file: 'out.csv',
          state_file: 'start.state.json',
          tmax: 0.05,
          events: [],
        },
        signal,
      )
      await expect(execution.done).rejects.toThrow('does not support state_file')
    },
  )

  it.skipIf(!!gridkit.path)(
    'refuses an output that would overwrite a case input',
    async ({ signal }) => {
      const execution = await run(
        'input collision',
        'IEEE39',
        {
          output_file: 'IEEE39.case.json',
          tmax: 0.05,
          dt_monitor: 0.01,
          events: [],
        },
        signal,
      )
      const source = listing(await readFile('cases/IEEE39.case.json', 'utf8'), ['Vm'])
      await expect(execution.done).rejects.toThrow('would overwrite an input')
      expect(await readFile(execution.request.output, 'utf8')).toBe(source)
    },
  )

  it("reads GridKit's long layout as it reads its wide one, an event's samples and all", async ({
    signal,
  }) => {
    const solver = { tmax: 0.2, dt_monitor: 0.01, events: FAULT }
    const [wide, long] = await Promise.all([
      run('wide', 'IEEE39', { ...solver, output_file: 'wide.csv' }, signal).then((run) => run.done),
      run(
        'long',
        'IEEE39',
        { ...solver, output_file: 'long.csv', output_layout: 'long' },
        signal,
      ).then((run) => run.done),
    ])
    expect(long.fields).toEqual(wide.fields)
    expect(long.progress.frames).toBe(wide.progress.frames)
    for (const { field } of wide.fields.filter(({ table }) => table === 'Bus'))
      expect(await readBack(long, field, long.progress.domain)).toEqual(
        await readBack(wide, field, wide.progress.domain),
      )
  })

  it('never reads what the last run of a solver file wrote, and keeps it when a run does not start', async ({
    signal,
  }) => {
    const solver = { output_file: 'out.csv', dt_monitor: 0.01, events: [] }
    const first = await run('again', 'IEEE39', { ...solver, tmax: 0.1 }, signal)
    expect((await first.done).progress.domain[1]).toBeCloseTo(0.1, 9)
    // A shorter run with the same folder and output.
    const folder = join(root, 'again')
    await writeFile(
      join(folder, 'IEEE39.solver.json'),
      JSON.stringify({ system_model_file: 'IEEE39.case.json', ...solver, tmax: 0.05 }),
    )
    const request = { ...first.request, tmax: 0.05 }
    const out = join(folder, 'out.csv')
    const written = await readFile(out, 'utf8')
    // A missing GridKit starts nothing, and the previous output is untouched.
    await expect(
      simulate(
        first.kase,
        {
          ...request,
          results: randomUUID(),
          gridkit: { ...gridkit, path: join(folder, 'missing') },
        },
        stores,
        { wasm, signal, reading: () => {}, progress: () => {}, log: () => {} },
      ),
    ).rejects.toThrow(/GridKit Path/)
    expect(await readFile(out, 'utf8')).toBe(written)
    // Same for a broken install that fails to start. Outside Windows a non-binary executable runs as
    // a shell script, so the broken one names a missing interpreter.
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
        { ...request, results: randomUUID(), gridkit: { ...gridkit, path: broken } },
        stores,
        { signal, reading: () => {}, progress: () => {}, log: () => {} },
      ),
    ).rejects.toThrow(/did not start.*GridKit Path/)
    expect(await readFile(out, 'utf8')).toBe(written)
    const results = await simulate(first.kase, { ...request, results: randomUUID() }, stores, {
      wasm,
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
    // The first run already read its solver file; the second reads this one.
    await writeFile(
      join(first.folder, 'IEEE39.solver.json'),
      JSON.stringify({ system_model_file: 'IEEE39.case.json', ...solver, tmax: 0.05 }),
    )
    const order: string[] = []
    const second = simulate(
      first.kase,
      { ...first.request, run: randomUUID(), results: randomUUID(), tmax: 0.05 },
      stores,
      {
        wasm,
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
    expect(first.resultsFile()!.progress.frames).toBeGreaterThan(0)
    expect(results.progress.domain[1]).toBeCloseTo(0.05, 9)
  })

  it('explains why GridKit could not finish', async ({ signal }) => {
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
  })

  it('stops with its process when cancelled, and reads what it wrote to its end, which exports as GridKit wrote it', async ({
    signal,
  }) => {
    const { folder, request, done, spawned, released, resultsFile } = await run(
      'cancel',
      'IEEE39',
      { output_file: 'out.csv', tmax: 1000, dt_monitor: 0.001, events: [] },
      signal,
      { progress: (stop) => stop(new Error('Cancelled by the test')) },
    )
    await expect(done).rejects.toThrow('Cancelled by the test')
    expect(released()).toBe(true)
    // Reads everything GridKit wrote before it stopped, not only up to the cancellation.
    const results = resultsFile()!
    expect(results.layout.path).toBe(request.output)
    expect(results.progress.growing).toBe(false)
    expect(results.progress.error).toBeUndefined()
    expect(results.progress.frames).toBeGreaterThan(0)
    expect(results.progress.domain[1]).toBeLessThan(1000)
    const exported = join(folder, 'exported.csv')
    await results.exportCsv(exported)
    const copy = await readFile(exported, 'utf8')
    // Matches GridKit's file, except a last row it may have been stopped partway through.
    expect((await readFile(request.output, 'utf8')).startsWith(copy)).toBe(true)
    expect(copy.split('\n').length - 2).toBe(results.progress.frames)
    if (runtime.kind === 'installed') expect(() => process.kill(spawned()!.pid, 0)).toThrow()
    else expect(spawned()).toBeUndefined()
  })
})
