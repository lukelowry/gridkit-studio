/** GridKit's own DynamicSimulation, run as Studio runs it: GRIDKIT_PATH names an install, else the
 *  one on PATH, else Studio's default image or GRIDKIT_IMAGE runs in Docker or Podman. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { type Arguments, type FieldSelection, type Parameters, read } from '@latkit/model'
import { beforeAll, describe, expect, it } from 'vitest'

import manifest from '../../package.json'
import {
  available,
  Case,
  catalog,
  diagnose,
  type Runtime,
  Simulation,
} from '../../src/gridkit/index.js'
import { ResultCache } from '../../src/results/index.js'
import type { GridKit, RunInfo, RunRequest, RuntimeProcess } from '../../src/shared/messages.js'

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
    values: RunRequest['values'],
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
    const request: RunRequest = {
      uri: 'file:///test.case.json',
      version: 1,
      values,
      outputs,
      gridkit: using,
      cacheBytes: 1 << 20,
    }
    const info: RunInfo = {
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

  /** Every recorded sample of the run, in order. */
  async function samples(simulation: Simulation): Promise<number[]> {
    const values: number[] = []
    const data = await simulation.results!.data(undefined, new AbortController().signal)
    for await (const block of read(
      data,
      {
        kind: 'samples',
        from: 'Bus',
        select: ['Vm'],
        window: { kind: 'range', between: [0, 0.1] },
      },
      { buffers: 'owned' },
    ))
      values.push(...block.columns.Vm!.values)
    return values
  }

  for (const [name, expected] of [
    ['IEEE39', [1.0485160677316046, 1.051597761407972]],
    ['TwoArea', [1.0000062524673949, 0.9976070932623818]],
  ] as const)
    it(`${name}: diagnoses, stages and records native CSV with reference voltages`, async ({
      signal,
    }) => {
      const model = await Case.read(`cases/${name}.case.json`, kase.catalog)
      expect(diagnose(model)).toEqual([])
      const { simulation, info, done, released } = await run(
        name,
        { tmax: 0.1, dt_monitor: 0.01 },
        signal,
        { model },
      )
      await done
      expect(released()).toBe(true)
      expect(info.frames).toBe(11)
      expect(info.domain).toEqual([0, 0.1])
      const csv = (await readFile(info.path, 'utf8')).trim().split('\n')
      expect(csv.shift()).toBe('t,Bus_1_Vm,Bus_2_Vm')
      const rows = csv.map((row) => row.split(',').map(Number))
      rows.forEach((row, i) => {
        expect(row[0]).toBeCloseTo(i * 0.01, 12)
        expect(row.every(Number.isFinite)).toBe(true)
      })
      expected.forEach((value, i) => expect(rows[0]![i + 1]).toBeCloseTo(value, 6))
      const decoded = await samples(simulation)
      expect(decoded).toHaveLength(22)
      expect(decoded.every(Number.isFinite)).toBe(true)
      expect(decoded).toEqual(rows.flatMap((row) => row.slice(1)))
    })

  it('records multiple fields in native column order', async ({ signal }) => {
    const { info, done } = await run('multiple', { tmax: 0.1, dt_monitor: 0.01 }, signal, {
      outputs: [{ from: 'Bus', select: ['Va', 'Vm'], rows: { kind: 'ids', ids: ['Bus/2'] } }],
    })
    await done
    expect((await readFile(info.path, 'utf8')).split('\n')[0]).toBe('t,Bus_2_Vm,Bus_2_Va')
    expect(info.frames).toBe(11)
  })

  it('WECC240: records every bus angle, starting at the case power flow', async ({ signal }) => {
    const text = await readFile('cases/WECC240.case.json', 'utf8')
    const model = await Case.parse(text, kase.catalog)
    expect(diagnose(model)).toEqual([])
    const { info, done } = await run('WECC240', { tmax: 0.1, dt_monitor: 0.01 }, signal, {
      model,
      outputs: [{ from: 'Bus', select: ['Va'] }],
    })
    await done
    expect(info.frames).toBe(11)
    // Columns follow the buses in file order; at t = 0 each angle is its initial voltage's.
    const buses = (JSON.parse(text) as { buses: { init: { Vr: number; Vi: number } }[] }).buses
    const first = (await readFile(info.path, 'utf8')).split('\n')[1]!.split(',').map(Number)
    expect(first.slice(1)).toHaveLength(buses.length)
    buses.forEach(({ init }, i) =>
      expect(first[i + 1]).toBeCloseTo(Math.atan2(init.Vi, init.Vr), 6),
    )
  })

  it('simulates a staged bus fault and records the event boundaries', async ({ signal }) => {
    const { info, done } = await run(
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
    const rows = (await readFile(info.path, 'utf8'))
      .trim()
      .split('\n')
      .slice(1)
      .map((row) => row.split(',').map(Number))
    expect(info.frames).toBe(23)
    expect(info.domain).toEqual([0, 0.2])
    expect(rows.filter((row) => Math.abs(row[0]! - 0.05) < 1e-12)).toHaveLength(2)
    expect(rows.filter((row) => Math.abs(row[0]! - 0.1) < 1e-12)).toHaveLength(2)
    expect(rows.every((row) => row.every(Number.isFinite))).toBe(true)
    expect(Math.min(...rows.map((row) => row[1]!))).toBeLessThan(0.8)
  })

  it('rejects a results format before starting a process: runs write CSV only', async ({
    signal,
  }) => {
    const { done, owned } = await run('unsupported', { output_format: 'arrow' }, signal)
    await expect(done).rejects.toThrow('Unknown simulation parameter: output_format')
    expect(owned()).toBeUndefined()
  })

  it('reports native initialization errors and retains the solver log, then retries successfully', async ({
    signal,
  }) => {
    const text = await readFile('cases/TwoArea.case.json', 'utf8')
    const invalid = await Case.parse(
      text.replace(/"Ispdlim":\s*0\.0/, '"Ispdlim":2.0'),
      kase.catalog,
    )
    const failed = await run('native-error', { tmax: 0.1 }, signal, { model: invalid })
    await expect(failed.done).rejects.toThrow(/Ispdlim|code/)
    expect(failed.released()).toBe(true)
    expect(await readFile(join(root, 'native-error', 'solver.log'), 'utf8')).toMatch(/Ispdlim/)
    const retry = await run('retry', { tmax: 0.1, dt_monitor: 0.01 }, signal)
    await retry.done
    expect(retry.info.frames).toBe(11)
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
    await expect(done).rejects.toThrow(`never pulls images. Pull it yourself with`)
    expect(owned()).toBeUndefined()
    await expect(promisify(execFile)(cli, ['image', 'inspect', image])).rejects.toThrow()
  })

  it('rejects an empty signal selection before starting a process', async ({ signal }) => {
    const { done, owned } = await run('empty', {}, signal, { outputs: [] })
    await expect(done).rejects.toThrow('monitored signal')
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
