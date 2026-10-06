import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { Case, catalog, selections } from '../gridkit/index.js'
import type { SimulationInfo } from '../shared/messages.js'
import { analyze, compare, snapshot } from './analysis.js'
import { Readers } from './readers.js'
import { ResultCache, Results } from './results.js'
import { querySignals } from './signals.js'
import { rank, sibling } from './study.js'

describe('recorded result analysis', () => {
  it('scans pages with exact extrema, stable IDs, coverage and historical provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridkit-analysis-'))
    try {
      const kase = await Case.parse(
        '{"buses":[{"class":"Bus","number":1,"name":"A"},{"class":"Bus","number":2,"name":"B"}]}',
        catalog,
      )
      const outputs = [{ from: 'Bus', select: ['Vm'] }]
      const path = join(directory, 'results.csv')
      await writeFile(
        path,
        'time,Bus_A_Vm,Bus_B_Vm\n' +
          Array.from(
            { length: 200 },
            (_, n) =>
              `${n / 100},${n === 120 ? 'NaN' : n === 80 || n === 81 ? 0.5 : 1},${n === 150 ? 1.5 : 1}\n`,
          ).join(''),
      )
      const info: SimulationInfo = {
        id: 'one',
        revision: { uri: 'file:///old.case.json', version: 2 },
        fingerprint: kase.version,
        name: 'test',
        state: 'complete',
        path,
        format: 'csv',
        frames: 0,
        domain: [0, 0],
        started: 0,
        outputs,
      }
      const cache = new ResultCache(2048)
      const run = new Results(info, kase, selections(kase, outputs), cache)
      const signal = new AbortController().signal
      await run.ingest(
        signal,
        () => true,
        async () => {},
      )
      const result = await analyze(run, { from: 'Bus', field: 'Vm' }, signal)
      expect(result.revision).toEqual(info.revision)
      expect(result.snapshot).toMatchObject({ pages: 4, frames: 200 })
      expect(result.rows).toEqual([
        {
          id: 'Bus/1',
          valid: 199,
          missing: 1,
          min: { value: 0.5, time: 0.8, frame: 80 },
          max: { value: 1, time: 0, frame: 0 },
        },
        {
          id: 'Bus/2',
          valid: 200,
          missing: 0,
          min: { value: 1, time: 0, frame: 0 },
          max: { value: 1.5, time: 1.5, frame: 150 },
        },
      ])
      const narrow = await analyze(
        run,
        { from: 'Bus', field: 'Vm', ids: ['Bus/2'], window: [1.5, 1.5] },
        signal,
      )
      expect(narrow.rows[0]).toMatchObject({ valid: 1, min: { value: 1.5, time: 1.5 } })
      const measured = await analyze(
        run,
        {
          from: 'Bus',
          field: 'Vm',
          order: 'duration',
          metrics: [
            { kind: 'threshold', lower: 0.9, durationMethod: 'left-hold', maxGapSeconds: 0.02 },
            { kind: 'initial-final' },
          ],
        },
        signal,
      )
      expect(measured.population).toMatchObject({
        measured: 2,
        unmeasured: 0,
        affected: 1,
        missingSamples: 1,
      })
      expect(measured.rows[0]!.threshold!.estimatedSeconds).toBeCloseTo(0.02)
      expect(measured.rows[0]!.threshold!.unknownSeconds).toBeCloseTo(0.02)
      expect(
        compare(measured, measured, 2).rows.find((row) => row.id === 'Bus/1')!.durationDelta,
      ).toBeNull()
      const input = {
        uri: info.revision.uri,
        run: info.id,
        from: 'Bus',
        field: 'Vm',
        ids: ['Bus/1'],
        window: [0, 1.99] as const,
      }
      const exact = await querySignals(
        run,
        { ...input, representation: { kind: 'exact', maxSamples: 3, offset: 79 } },
        signal,
      )
      expect(exact.series[0]!.samples).toEqual([
        { time: 0.79, frame: 79, value: 1 },
        { time: 0.8, frame: 80, value: 0.5 },
        { time: 0.81, frame: 81, value: 0.5 },
      ])
      expect(exact.nextOffset).toBe(82)
      const envelope = await querySignals(
        run,
        { ...input, representation: { kind: 'envelope', buckets: 2 } },
        signal,
      )
      expect(envelope.series[0]!.samples).toContainEqual({ time: 0.8, frame: 80, value: 0.5 })
      expect(envelope.series[0]!.samples).toContainEqual({ time: 1.2, frame: 120, value: null })
      expect(envelope.series[0]!.samples.length).toBeLessThanOrEqual(10)
      const last = await querySignals(
        run,
        { ...input, representation: { kind: 'exact', maxSamples: 5, offset: 198 } },
        signal,
      )
      expect(last.nextOffset).toBeNull()
      expect(last.series[0]!.samples).toHaveLength(2)
      const captured = snapshot(run)
      captured.pages = 1
      captured.info.frames = 64
      captured.info.domain = [0, 0.63]
      const early = await analyze(run, { from: 'Bus', field: 'Vm' }, signal, captured)
      expect(early.rows[0]).toMatchObject({ valid: 64, min: { value: 1 } })
      expect(cache.bytes).toBeLessThanOrEqual(2048)
      expect(compare(result, result, 1)).toMatchObject({
        matched: 2,
        onlyBefore: 0,
        onlyAfter: 0,
        rows: [{ id: 'Bus/1', minDelta: 0, maxDelta: 0 }],
      })
      await expect(analyze(run, { from: 'Bus', field: 'Va' }, signal)).rejects.toThrow(
        /not recorded/,
      )
      await expect(
        analyze(run, { from: 'Bus', field: 'Vm', ids: ['Bus/999'] }, signal),
      ).rejects.toThrow()
      const controller = new AbortController()
      controller.abort(new Error('cancelled'))
      await expect(analyze(run, { from: 'Bus', field: 'Vm' }, controller.signal)).rejects.toThrow(
        /cancelled/,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('cancels and drains every reader before retiring a result', async () => {
    const readers = new Readers<object>()
    const result = {}
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let signal!: AbortSignal
    const read = readers.use([result], new AbortController().signal, async (s) => {
      signal = s
      await held
      s.throwIfAborted()
    })
    const rejected = expect(read).rejects.toThrow(/cleared or replaced/)
    let retired = false
    const retire = readers.retire(result).then(() => {
      retired = true
    })
    expect(signal.aborted).toBe(true)
    expect(retired).toBe(false)
    release()
    await rejected
    await retire
    expect(retired).toBe(true)
    await expect(
      readers.use([result], new AbortController().signal, async () => 1),
    ).rejects.toThrow(/no longer open/)
  })
  it('ranks borrowed study siblings with stable targets and distinguishes failures from missing files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridkit-study-'))
    try {
      const kase = await Case.parse('{"buses":[{"class":"Bus","number":1,"name":"A"}]}', catalog)
      const outputs = [{ from: 'Bus', select: ['Vm'] }]
      const path = join(directory, 'results_7.csv')
      await writeFile(path, 'time,Bus_A_Vm\n0,1\n1,0.8\n')
      await writeFile(join(directory, 'results_8.csv'), 'time,Bus_A_Vm\n0,1\n1,0.5\n')
      const info: SimulationInfo = {
        id: 'displayed-id',
        revision: { uri: 'file:///case', version: 1 },
        fingerprint: kase.version,
        name: 'study',
        state: 'complete',
        path,
        format: 'csv',
        frames: 0,
        domain: [0, 0],
        started: 0,
        outputs,
        contingency: {
          study: 'stable-study',
          offset: 7,
          buses: [1, 2, 3, 4],
          failed: [2],
          done: 4,
          shown: 0,
        },
      }
      const current = new Results(
        info,
        kase,
        selections(kase, outputs),
        new ResultCache(2048),
        directory,
      )
      const signal = new AbortController().signal
      await current.ingest(
        signal,
        () => true,
        async () => {},
      )
      const before = structuredClone(info)
      const ranked = await rank(current, { from: 'Bus', field: 'Vm', limit: 1 }, signal)
      expect(ranked).toMatchObject({
        study: 'stable-study',
        total: 4,
        failed: [2],
        unavailable: [3],
        rows: [
          { contingency: 1, bus: 2, state: 'measured', worst: { min: { value: 0.5, time: 1 } } },
        ],
      })
      expect(info).toEqual(before)
      const borrowed = await sibling(current, 1, signal)
      expect(borrowed.ownedDirectory).toBeUndefined()
      expect((await analyze(borrowed, { from: 'Bus', field: 'Vm' }, signal)).run).toBe(
        'stable-study',
      )
      await borrowed.dispose(directory)
      expect(await readFile(path, 'utf8')).toContain('0.8')
      await expect(rank(current, { from: 'Bus', field: 'Va' }, signal)).rejects.toThrow(
        /not recorded/,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
