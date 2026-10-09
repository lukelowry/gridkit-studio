/** GridKit's own programs, run as Studio runs them: on a solver file, in its folder, with the case it
 *  names beside it. GRIDKIT_PATH names an install, else the one on PATH, else Studio's default image
 *  or GRIDKIT_IMAGE runs in Docker or Podman. */

import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { type Domain, read, rowAt, rowCount, sampleAt, type SampleWindow } from '@latkit/model'
import { applyEdits, modify } from 'jsonc-parser'
import { beforeAll, describe, expect, it } from 'vitest'

import manifest from '../../package.json'
import { apply } from '../../src/gridkit/edits.js'
import {
  available,
  Case,
  catalog,
  diagnose,
  recordingOf,
  type Runtime,
  simulate,
} from '../../src/gridkit/index.js'
import { recordEdits } from '../../src/gridkit/recording.js'
import { ResultCache, type ResultsFile } from '../../src/results/index.js'
import type {
  GridKit,
  Program,
  Run,
  RuntimeProcess,
  SimulationRequest,
} from '../../src/shared/messages.js'
import { contingencyFile, outputOf, readSolver } from '../../src/shared/study.js'

const gridkit: GridKit = {
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

  beforeAll(async () => {
    await mkdir('output/simulation', { recursive: true })
    root = resolve(await mkdtemp('output/simulation/run-'))
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

  /** Runs `program` on a solver file written into a folder of its own, `name`, beside a copy of
   *  case `model` whose `mon` lists `record` writes. Reads the output where the solver file and the
   *  case say, as Studio does, until the run ends or `signal` aborts. `progress` hears of each run
   *  of frames read, and may stop the run. */
  async function run(
    name: string,
    model: string,
    solver: Record<string, unknown>,
    signal: AbortSignal,
    {
      program = 'DynamicSimulation',
      record = (kase: Case, text: string) => apply(text, recordEdits(kase, 'Bus', ['Vm'], [])),
      progress = () => {},
      using = gridkit,
      mount = root,
    }: {
      program?: Program
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
    const sink = outputOf(`${model}.solver.json`, study, recordingOf(kase).monitor)
    const request: SimulationRequest = {
      uri: pathToFileURL(casePath).href,
      version: 1,
      program,
      solver: solverPath,
      output: join(folder, sink.file),
      format: sink.format,
      tmax: study.tmax,
      root: mount,
      gridkit: using,
      cacheBytes: 1 << 20,
    }
    const job: Run = { id: name, uri: request.uri, command: program, state: 'running' }
    let owned: RuntimeProcess | undefined
    let released = false
    const controller = new AbortController()
    const done = simulate(kase, request, job, new ResultCache(1 << 20), {
      signal: AbortSignal.any([signal, controller.signal]),
      reading: () => {},
      progress: async () => progress((reason) => controller.abort(reason)),
      log: () => {},
      lifecycle: (process) => {
        if (process) owned = process
        else released = true
      },
    })
    return { kase, folder, job, done, owned: () => owned, released: () => released }
  }

  /** What Studio reads back of `field` for each recorded bus over `window`. */
  async function readBack(results: ResultsFile, field: string, window: SampleWindow) {
    const found: { row: number; t: number; value: number | null }[] = []
    const span: Domain =
      window.kind === 'range'
        ? window.between
        : window.kind === 'at'
          ? [window.value, window.value]
          : results.info.domain
    const data = await results.data(span, new AbortController().signal)
    for await (const block of read(data, { kind: 'samples', from: 'Bus', select: [field], window }))
      for (let frame = 0; frame < block.coordinates.length; frame++)
        for (let i = 0; i < rowCount(block.rows); i++)
          found.push({
            row: rowAt(block.rows, i),
            t: block.coordinates[frame]!,
            value: sampleAt(block.columns[field]!, i, frame),
          })
    return found
  }

  for (const name of ['IEEE39', 'TwoArea', 'WECC240'])
    it(`${name}: writes where its solver file says, from the case's power flow, and every sample reads back`, async ({
      signal,
    }) => {
      expect(diagnose(await Case.read(`cases/${name}.case.json`, catalog))).toEqual([])
      const { folder, done, released } = await run(
        name,
        name,
        { output_file: 'out.csv', tmax: 0.1, dt_monitor: 0.01, events: [] },
        signal,
        { record: (kase, text) => apply(text, recordEdits(kase, 'Bus', ['Vm', 'Va'], [])) },
      )
      const results = await done
      const { info } = results
      expect(released()).toBe(true)
      await access(join(folder, 'out.csv'))
      expect(info.domain[0]).toBe(0)
      expect(info.domain[1]).toBeCloseTo(0.1, 9)
      const initial = (await busesOf(name)).map(({ init }) => ({
        Vm: Math.hypot(init.Vr, init.Vi),
        Va: Math.atan2(init.Vi, init.Vr),
      }))
      for (const field of ['Vm', 'Va'] as const) {
        // Every bus, at least once a monitor step, and every value a number.
        const samples = await readBack(results, field, { kind: 'range', between: info.domain })
        expect(new Set(samples.map(({ row }) => row)).size).toBe(initial.length)
        expect(samples.every(({ value }) => Number.isFinite(value))).toBe(true)
        const times = [...new Set(samples.map(({ t }) => t))].sort((a, b) => a - b)
        expect(times.every((t, i) => !i || t - times[i - 1]! <= 0.01 + 1e-9)).toBe(true)
        // Each bus starts where the case's power flow left it.
        const start = await readBack(results, field, { kind: 'at', value: 0 })
        expect(start).toHaveLength(initial.length)
        for (const { row, value } of start) expect(value).toBeCloseTo(initial[row]![field], 3)
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
        record: (_, text) =>
          applyEdits(text, modify(text, ['buses', row, 'mon'], ['Va', 'Vm'], {})),
      },
    )
    const results = await done
    const { info } = results
    for (const field of ['Va', 'Vm']) {
      const samples = await readBack(results, field, { kind: 'range', between: info.domain })
      expect(new Set(samples.map(({ row }) => row))).toEqual(new Set([row]))
    }
    // The case's own lists record on: its machines' speeds.
    expect(info.outputs.some(({ from }) => from !== 'Bus')).toBe(true)
  })

  it('sags the faulted bus while the fault lasts', async ({ signal }) => {
    const { kase, done } = await run(
      'fault',
      'IEEE39',
      { output_file: 'out.csv', tmax: 0.2, dt_monitor: 0.01, events: FAULT },
      signal,
    )
    const results = await done
    const { info } = results
    expect(info.domain[1]).toBeCloseTo(0.2, 9)
    const faults = kase.table('BusFault')
    const bus = kase.cell(faults, 'ports.bus', 0) as number
    const samples = (await readBack(results, 'Vm', { kind: 'range', between: info.domain })).filter(
      (sample) => sample.row === bus,
    )
    expect(samples.every(({ value }) => Number.isFinite(value))).toBe(true)
    const lowest = (from: number, to: number) =>
      Math.min(...samples.filter(({ t }) => t >= from && t <= to).map(({ value }) => value!))
    expect(lowest(0, 0.04)).toBeGreaterThan(0.9)
    expect(lowest(0.05, 0.1)).toBeLessThan(0.8)
  })

  it('studies each fault in turn, one file each beside the solver file, and shows the first', async ({
    signal,
  }) => {
    const { kase, folder, done } = await run(
      'contingencies',
      'IEEE39',
      { output_file: 'study.csv', tmax: 0.2, dt_monitor: 0.01, events: FAULT },
      signal,
      { program: 'ContingencyAnalysis' },
    )
    const results = await done
    const { info } = results
    const faults = kase.table('BusFault')
    const buses = kase.table('Bus')
    const faulted = Array.from(faults.records, (_, row) => kase.cell(faults, 'ports.bus', row))
    const study = info.contingency!
    expect(study.buses).toEqual(faulted.map((row) => kase.native(buses, row as number)))
    expect(study.written).toEqual(faulted.map((_, n) => n))
    expect(study.failed).toEqual([])
    expect(study.shown).toBe(0)
    for (const n of study.written) await access(contingencyFile(study, n))
    expect(info.path).toBe(join(folder, 'study_0.csv'))
    const sagged = (await readBack(results, 'Vm', { kind: 'range', between: [0.05, 0.1] })).filter(
      (sample) => sample.row === faulted[0],
    )
    expect(Math.min(...sagged.map(({ value }) => value!))).toBeLessThan(0.8)
  })

  it('never reads what the last run of a solver file wrote', async ({ signal }) => {
    const solver = { output_file: 'out.csv', dt_monitor: 0.01, events: [] }
    const first = await run('again', 'IEEE39', { ...solver, tmax: 0.1 }, signal)
    expect((await first.done).info.domain[1]).toBeCloseTo(0.1, 9)
    // The same folder and output, read again by a shorter run.
    const folder = join(root, 'again')
    await writeFile(
      join(folder, 'IEEE39.solver.json'),
      JSON.stringify({ system_model_file: 'IEEE39.case.json', ...solver, tmax: 0.05 }),
    )
    const kase = first.kase
    const uri = pathToFileURL(join(folder, 'IEEE39.case.json')).href
    const again: Run = { id: 'again-2', uri, command: 'DynamicSimulation', state: 'running' }
    const results = await simulate(
      kase,
      {
        uri,
        version: 1,
        program: 'DynamicSimulation',
        solver: join(folder, 'IEEE39.solver.json'),
        output: join(folder, 'out.csv'),
        format: 'csv',
        tmax: 0.05,
        root,
        gridkit,
        cacheBytes: 1 << 20,
      },
      again,
      new ResultCache(1 << 20),
      { signal, reading: () => {}, progress: async () => {}, log: () => {} },
    )
    expect(results.info.domain[1]).toBeCloseTo(0.05, 9)
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
    expect((await retry.done).info.domain[1]).toBeCloseTo(0.1, 9)
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
    const { job, done, owned, released } = await run(
      'cancel',
      'IEEE39',
      { output_file: 'out.csv', tmax: 1000, dt_monitor: 0.001, events: [] },
      signal,
      { progress: (stop) => stop(new Error('Cancelled by the test')) },
    )
    await expect(done).rejects.toThrow('Cancelled by the test')
    expect(released()).toBe(true)
    expect(job.results!.frames).toBeGreaterThan(0)
    expect(job.results!.domain[1]).toBeLessThan(1000)
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
