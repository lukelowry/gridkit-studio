import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { type Arguments, type Parameters, read } from '@latkit/model'

import catalog from '../../catalog.json'
import { Case } from '../../src/gridkit/case.js'
import { catalogOf } from '../../src/gridkit/definition.js'
import { Simulation } from '../../src/gridkit/simulation.js'
import type { RunInfo, RunRequest, RuntimeProcess } from '../../src/messages.js'
import { ResultCache } from '../../src/results/results.js'
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'gridkit-native-test-'))
  const kase = await Case.parse(
    await readFile('tests/fixtures/IEEE39.case.json', 'utf8'),
    catalogOf(JSON.stringify(catalog)),
  )
  const records: { format: string; frames: number; values: number[]; durationMs: number }[] = []
  const runtime: RunRequest['runtime'] = {
    method: process.env.GRIDKIT_TEST_SOLVER ? 'installed' : 'docker',
    executable: process.env.GRIDKIT_TEST_SOLVER ?? '',
    image: process.env.GRIDKIT_TEST_IMAGE ?? 'ghcr.io/lukelowry/gridkit:arrow',
  }
  async function execute(name: string, format: 'arrow' | 'csv', cancel = false) {
    const directory = join(root, name)
    await mkdir(directory)
    const input: RunRequest = {
      uri: 'file:///test.case.json',
      version: 1,
      values: {
        tmax: cancel ? 1000 : 0.1,
        dt_monitor: cancel ? 0.001 : 0.01,
        output_format: format,
      },
      outputs: [{ from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1', 'Bus/2'] } }],
      runtime,
      cacheBytes: 1 << 20,
    }
    const info: RunInfo = {
      id: name,
      revision: input,
      fingerprint: kase.version,
      name: 'IEEE39',
      state: 'running',
      path: join(directory, 'results.' + format),
      format,
      frames: 0,
      domain: [0, 0],
      started: Date.now(),
      outputs: input.outputs,
    }
    let owned: RuntimeProcess | undefined
    let cleaned = false
    const simulation = new Simulation(
      kase,
      input,
      directory,
      new ResultCache(1 << 20),
      info,
      (process) => {
        if (process) owned = process
        else cleaned = true
      },
    )
    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Solver test timed out.')), 90000)
    let failure: unknown
    try {
      await simulation.run(input.values as Arguments<Parameters>, {
        signal: controller.signal,
        outputs: input.outputs,
        maxBlockBytes: 256 << 10,
        publish: async () => {
          if (cancel) controller.abort(new Error('Test cancellation'))
        },
        progress: () => {},
        log: (entry) => console.log(entry.message),
      })
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(timer)
    }
    assert.ok(cleaned, 'Runtime ownership was not released')
    if (cancel) {
      assert.match(String(failure), /Test cancellation/)
      assert.ok(info.frames > 0)
      assert.ok(info.domain[1] < 1000)
      if (owned?.container) {
        const { stdout } = await promisify(execFile)(owned.executable, [
          'ps',
          '-aq',
          '--filter',
          'name=' + owned.container,
        ])
        assert.equal(stdout.trim(), '')
      }
      return { cancelledFrames: info.frames, cleanupMs: performance.now() - started }
    }
    if (failure) throw failure
    assert.ok(info.frames >= 10)
    const data = await simulation.results!.data(undefined, new AbortController().signal)
    const values: number[] = []
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
    assert.ok(values.every(Number.isFinite))
    const record = { format, frames: info.frames, values, durationMs: performance.now() - started }
    records.push(record)
    return record
  }
  try {
    for (const format of ['arrow', 'csv'] as const) await execute(format, format)
    assert.equal(records[0]!.frames, records[1]!.frames)
    assert.equal(records[0]!.values.length, records[1]!.values.length)
    records[0]!.values.forEach((value, i) =>
      assert.ok(Math.abs(value - records[1]!.values[i]!) < 1e-5),
    )
    const cancellation = await execute('cancel', 'arrow', true)
    await mkdir('output/tests', { recursive: true })
    const report = {
      formats: records.map(({ values, ...record }) => ({ ...record, samples: values.length })),
      cancellation,
    }
    await writeFile('output/tests/solver-report.json', JSON.stringify(report, null, 2))
    console.log(report)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
