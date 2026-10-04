/** GridKit's own DynamicSimulation, run where GridKit is installed: the dev container has it, and
 *  GRIDKIT_PATH names an install elsewhere. */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Arguments, type Parameters, read } from '@latkit/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import catalog from '../../catalog.json'
import { Case } from '../../src/gridkit/case.js'
import { catalogOf } from '../../src/gridkit/definition.js'
import { dynamicSimulation } from '../../src/gridkit/runtime.js'
import { Simulation } from '../../src/gridkit/simulation.js'
import type { RunInfo, RunRequest, RuntimeProcess } from '../../src/messages.js'
import { ResultCache } from '../../src/results/results.js'

const gridkit = process.env.GRIDKIT_PATH ?? ''

describe('DynamicSimulation', () => {
  let root: string
  let kase: Case

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gridkit-studio-simulation-'))
    // Without GridKit there is nothing to test, and that is a failure said once.
    await dynamicSimulation(gridkit)
    kase = await Case.parse(
      await readFile('tests/fixtures/IEEE39.case.json', 'utf8'),
      catalogOf(JSON.stringify(catalog)),
    )
  })
  afterAll(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))

  /** Run the case into its own folder under `name`, until it ends or `signal` aborts; `publish`
   *  hears each block of frames, and may stop the run. */
  async function run(
    name: string,
    values: RunRequest['values'],
    signal: AbortSignal,
    publish: (stop: (reason: Error) => void) => void = () => {},
  ) {
    const directory = join(root, name)
    await mkdir(directory)
    const format = values.output_format as RunInfo['format']
    const request: RunRequest = {
      uri: 'file:///test.case.json',
      version: 1,
      values,
      outputs: [{ from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1', 'Bus/2'] } }],
      gridkit,
      cacheBytes: 1 << 20,
    }
    const info: RunInfo = {
      id: name,
      revision: request,
      fingerprint: kase.version,
      name: 'IEEE39',
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
      kase,
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

  it('records the same samples as Arrow and as CSV', async ({ signal }) => {
    const recorded: { frames: number; values: number[] }[] = []
    for (const output_format of ['arrow', 'csv']) {
      const { simulation, info, done, released } = await run(
        output_format,
        { tmax: 0.1, dt_monitor: 0.01, output_format },
        signal,
      )
      await done
      expect(released()).toBe(true)
      expect(info.frames).toBeGreaterThanOrEqual(10)
      recorded.push({ frames: info.frames, values: await samples(simulation) })
    }
    const [arrow, csv] = recorded
    expect(arrow!.values.every(Number.isFinite)).toBe(true)
    expect(csv!.frames).toBe(arrow!.frames)
    expect(csv!.values).toHaveLength(arrow!.values.length)
    arrow!.values.forEach((value, i) =>
      expect(Math.abs(value - csv!.values[i]!)).toBeLessThan(1e-5),
    )
  })

  it('stops with its process when cancelled, keeping the frames it wrote', async ({ signal }) => {
    const { info, done, owned, released } = await run(
      'cancel',
      { tmax: 1000, dt_monitor: 0.001, output_format: 'arrow' },
      signal,
      (stop) => stop(new Error('Cancelled by the test')),
    )
    await expect(done).rejects.toThrow('Cancelled by the test')
    expect(released()).toBe(true)
    expect(info.frames).toBeGreaterThan(0)
    expect(info.domain[1]).toBeLessThan(1000)
    // The process is gone, not left to finish its thousand seconds.
    expect(() => process.kill(owned()!.pid, 0)).toThrow()
  })
})
