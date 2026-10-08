/** GridKit's own DynamicSimulation, run as Studio runs it: GRIDKIT_PATH names an install, else the
 *  one on PATH, else Studio's default image or GRIDKIT_IMAGE runs in Docker or Podman. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  type Arguments,
  type FieldSelection,
  type Parameters,
  read,
  rowAt,
  rowCount,
  sampleAt,
  type SampleWindow,
} from '@latkit/model'
import { beforeAll, describe, expect, it } from 'vitest'

import manifest from '../../package.json'
import {
  available,
  Case,
  catalog,
  contingencyFile,
  diagnose,
  type Runtime,
  Simulation,
} from '../../src/gridkit/index.js'
import { ResultCache } from '../../src/results/index.js'
import type {
  GridKit,
  RuntimeProcess,
  SimulationInfo,
  SimulationRequest,
} from '../../src/shared/messages.js'

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

describe('DynamicSimulation', () => {
  let root: string
  let kase: Case
  let runtime: Runtime

  beforeAll(async () => {
    await mkdir('output/simulation', { recursive: true })
    root = await mkdtemp('output/simulation/run-')
    console.log('Simulation inputs, results and logs:', root)
    // Without GridKit there is nothing to test, and that is a failure said once.
    runtime = await available(gridkit)
    console.log('GridKit runs', runtime)
    kase = await Case.parse(await readFile('cases/IEEE39.case.json', 'utf8'), catalog)
  })

  /** Run `model` into its own folder under `name`, until it ends or `signal` aborts. `publish`
   *  hears each block of frames, and may stop the run. */
  async function run(
    name: string,
    values: SimulationRequest['values'],
    signal: AbortSignal,
    {
      publish = () => {},
      model = kase,
      outputs = [{ from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1', 'Bus/2'] } }],
      using = gridkit,
    }: {
      publish?: (stop: (reason: Error) => void) => void
      model?: Case
      outputs?: readonly FieldSelection[]
      using?: GridKit
    } = {},
  ) {
    const directory = join(root, name)
    await mkdir(directory)
    const format = 'csv'
    const request: SimulationRequest = {
      uri: 'file:///test.case.json',
      version: 1,
      values,
      outputs,
      gridkit: using,
      cacheBytes: 1 << 20,
    }
    const info: SimulationInfo = {
      id: name,
      revision: request,
      fingerprint: model.version,
      name: model.name,
      state: 'running',
      path: join(directory, 'results.' + format),
      format,
      frames: 0,
      domain: [0, 0],
      started: Date.now(),
      outputs: request.outputs,
    }
    let owned: RuntimeProcess | undefined
    let released = false
    const simulation = new Simulation(
      model,
      request,
      directory,
      new ResultCache(1 << 20),
      info,
      (process) => {
        if (process) owned = process
        else released = true
      },
    )
    const controller = new AbortController()
    const done = simulation.run(values as Arguments<Parameters>, {
      signal: AbortSignal.any([signal, controller.signal]),
      outputs: request.outputs,
      maxBlockBytes: 256 << 10,
      publish: async () => publish((reason) => controller.abort(reason)),
      progress: () => {},
      log: () => {},
    })
    return { simulation, info, done, owned: () => owned, released: () => released }
  }

  /** A case's buses in file order, which are the rows Studio reads them back as. */
  async function busesOf(name: string) {
    const text = await readFile(`cases/${name}.case.json`, 'utf8')
    return (JSON.parse(text) as { buses: { number: number; init: { Vr: number; Vi: number } }[] })
      .buses
  }

  /** What Studio reads back of `field` for each recorded bus over `window`. */
  async function readBack(simulation: Simulation, field: string, window: SampleWindow) {
    const found: { row: number; t: number; value: number | null }[] = []
    const data = await simulation.results!.data(undefined, new AbortController().signal)
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
    it(`${name}: runs from the case's power flow, and every sample reads back`, async ({
      signal,
    }) => {
      const model = await Case.read(`cases/${name}.case.json`, kase.catalog)
      expect(diagnose(model)).toEqual([])
      const { simulation, info, done, released } = await run(
        name,
        { tmax: 0.1, dt_monitor: 0.01 },
        signal,
        { model, outputs: [{ from: 'Bus', select: ['Vm', 'Va'] }] },
      )
      await done
      expect(released()).toBe(true)
      expect(info.domain[0]).toBe(0)
      expect(info.domain[1]).toBeCloseTo(0.1, 9)
      const initial = (await busesOf(name)).map(({ init }) => ({
        Vm: Math.hypot(init.Vr, init.Vi),
        Va: Math.atan2(init.Vi, init.Vr),
      }))
      for (const field of ['Vm', 'Va'] as const) {
        // Every bus, at least once a monitor step, and every value a number.
        const samples = await readBack(simulation, field, { kind: 'range', between: info.domain })
        expect(new Set(samples.map(({ row }) => row)).size).toBe(initial.length)
        expect(samples.every(({ value }) => Number.isFinite(value))).toBe(true)
        const times = [...new Set(samples.map(({ t }) => t))].sort((a, b) => a - b)
        expect(times.every((t, i) => !i || t - times[i - 1]! <= 0.01 + 1e-9)).toBe(true)
        // Each bus starts where the case's power flow left it.
        const start = await readBack(simulation, field, { kind: 'at', value: 0 })
        expect(start).toHaveLength(initial.length)
        for (const { row, value } of start) expect(value).toBeCloseTo(initial[row]![field], 3)
      }
    })

  it('records only the buses and fields it was asked for', async ({ signal }) => {
    const { simulation, info, done } = await run(
      'selected',
      { tmax: 0.1, dt_monitor: 0.01 },
      signal,
      { outputs: [{ from: 'Bus', select: ['Va', 'Vm'], rows: { kind: 'ids', ids: ['Bus/2'] } }] },
    )
    await done
    const row = (await busesOf('IEEE39')).findIndex((bus) => bus.number === 2)
    for (const field of ['Va', 'Vm']) {
      const samples = await readBack(simulation, field, { kind: 'range', between: info.domain })
      expect(new Set(samples.map(({ row }) => row))).toEqual(new Set([row]))
    }
  })

  it('sags the faulted bus while the fault lasts', async ({ signal }) => {
    const { simulation, info, done } = await run(
      'fault',
      {
        tmax: 0.2,
        dt_monitor: 0.01,
        fault: true,
        fault_bus: 'Bus/1',
        fault_start: 0.05,
        fault_duration: 0.05,
        fault_R: 0,
        fault_X: 0.01,
      },
      signal,
    )
    await done
    expect(info.domain[1]).toBeCloseTo(0.2, 9)
    const row = (await busesOf('IEEE39')).findIndex((bus) => bus.number === 1)
    const samples = (
      await readBack(simulation, 'Vm', { kind: 'range', between: info.domain })
    ).filter((sample) => sample.row === row)
    expect(samples.every(({ value }) => Number.isFinite(value))).toBe(true)
    const lowest = (from: number, to: number) =>
      Math.min(...samples.filter(({ t }) => t >= from && t <= to).map(({ value }) => value!))
    expect(lowest(0, 0.04)).toBeGreaterThan(0.9)
    expect(lowest(0.05, 0.1)).toBeLessThan(0.8)
  })

  it('faults every bus in turn, one result file each, and shows one whose bus sags', async ({
    signal,
  }) => {
    const { simulation, info, done } = await run(
      'contingencies',
      {
        program: 'ContingencyAnalysis',
        tmax: 0.2,
        dt_monitor: 0.01,
        fault_start: 0.05,
        fault_duration: 0.05,
        fault_R: 0,
        fault_X: 0.01,
      },
      signal,
      { outputs: [{ from: 'Bus', select: ['Vm'] }] },
    )
    await done
    const buses = await busesOf('IEEE39')
    const study = info.contingency!
    expect(study.buses).toEqual(buses.map((bus) => bus.number))
    expect(study.done).toBe(buses.length)
    expect(study.failed).not.toContain(study.shown)
    const written = await readdir(dirname(info.path))
    buses.forEach((_, i) => expect(written).toContain(contingencyFile(study.offset + i)))
    const row = buses.findIndex((bus) => bus.number === study.buses[study.shown])
    const faulted = (
      await readBack(simulation, 'Vm', { kind: 'range', between: [0.05, 0.1] })
    ).filter((sample) => sample.row === row)
    expect(Math.min(...faulted.map(({ value }) => value!))).toBeLessThan(0.8)
  })

  it('refuses a results format before starting a process: runs write CSV only', async ({
    signal,
  }) => {
    const { done, owned } = await run('unsupported', { output_format: 'arrow' }, signal)
    await expect(done).rejects.toThrow()
    expect(owned()).toBeUndefined()
  })

  it('says why GridKit could not finish, keeps its log, and runs again', async ({ signal }) => {
    const failed = await run('failure', { tmax: 0.1, dt_monitor: 0.01, max_steps: 1 }, signal)
    const error = await failed.done.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message.trim()).not.toBe('')
    expect(failed.released()).toBe(true)
    expect((await readFile(join(root, 'failure', 'solver.log'), 'utf8')).trim()).not.toBe('')
    const retry = await run('retry', { tmax: 0.1, dt_monitor: 0.01 }, signal)
    await retry.done
    expect(retry.info.domain[1]).toBeCloseTo(0.1, 9)
  })

  it('refuses an image this machine does not have, and never pulls it', async ({
    signal,
    skip,
  }) => {
    if (runtime.kind !== 'container') skip()
    const { cli } = runtime as Extract<Runtime, { kind: 'container' }>
    const image = 'ghcr.io/lukelowry/gridkit:studio-never-pulls'
    const { done, owned } = await run('unpulled', { tmax: 0.1 }, signal, {
      using: { ...gridkit, image },
    })
    await expect(done).rejects.toThrow(image)
    expect(owned()).toBeUndefined()
    await expect(promisify(execFile)(cli, ['image', 'inspect', image])).rejects.toThrow()
  })

  it('refuses an empty signal selection before starting a process', async ({ signal }) => {
    const { done, owned } = await run('empty', {}, signal, { outputs: [] })
    await expect(done).rejects.toThrow()
    expect(owned()).toBeUndefined()
  })

  it('stops with its process when cancelled, keeping the frames it wrote', async ({ signal }) => {
    const { info, done, owned, released } = await run(
      'cancel',
      { tmax: 1000, dt_monitor: 0.001 },
      signal,
      { publish: (stop) => stop(new Error('Cancelled by the test')) },
    )
    await expect(done).rejects.toThrow('Cancelled by the test')
    expect(released()).toBe(true)
    expect(info.frames).toBeGreaterThan(0)
    expect(info.domain[1]).toBeLessThan(1000)
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
