import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { blockBuffers, read, type SampleBatch, selectBatches, staticFields } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import catalogJson from '../../catalog.json'
import { Case } from '../gridkit/case.js'
import { catalogOf } from '../gridkit/definition.js'
import { selections } from '../gridkit/parameters.js'
import type { RunInfo } from '../shared/messages.js'
import { type Layout, readResults } from './decode.js'
import { ResultCache, Results } from './results.js'
describe('native results and ownership', () => {
  it('takes ownership of reused decoder buffers before resolving', () => {
    const cache = new ResultCache(10000)
    const values = new Float64Array([1, 2])
    const coordinates = new Float64Array([0, 1])
    const batch: SampleBatch = {
      kind: 'samples',
      index: { source: 's', version: 'v', type: 'Bus' },
      rows: { kind: 'range', offset: 0, count: 1 },
      firstFrame: 0,
      coordinates,
      columns: {
        Vm: { kind: 'numeric', values, offset: 0, length: 2, frameStride: 1, rowStride: 1 },
      },
    }
    cache.put('run:0', [batch])
    values.fill(99)
    coordinates.fill(99)
    expect(Array.from(cache.get('run:0')![0]!.columns.Vm!.values)).toEqual([1, 2])
    expect(Array.from(cache.get('run:0')![0]!.coordinates)).toEqual([0, 1])
  })
  it('owned query buffers can transfer without detaching retained case data', async () => {
    const kase = await Case.parse(
      '{"buses":[{"class":"Bus","number":1,"name":"A"}]}',
      catalogOf(JSON.stringify(catalogJson)),
    )
    for await (const batch of selectBatches(kase.data, staticFields(kase.schema), {
      buffers: 'owned',
      maxBlockBytes: 4096,
    })) {
      const moved = structuredClone(batch, { transfer: blockBuffers(batch) as ArrayBuffer[] })
      expect(moved.kind).toBe('rows')
    }
    expect(kase.cell(kase.table('Bus'), 'name', 0)).toBe('A')
    for await (const block of read(kase.data, {
      kind: 'rows',
      from: 'Bus',
      select: ['number'],
      limit: 1,
    }))
      expect(block.columns.number!.kind).toBe('numeric')
  })
  it('reads every page of a run with the layout its header gave the first', async () => {
    const kase = await Case.parse(
      '{"buses":[{"class":"Bus","number":1,"name":"A"}]}',
      catalogOf(JSON.stringify(catalogJson)),
    )
    const fields = selections(kase, [{ from: 'Bus', select: ['Vm'] }])
    const layout: Layout = {}
    const page = async (text: string) => {
      const values: number[] = []
      await readResults(
        Readable.from([Buffer.from(text)]),
        fields,
        kase,
        {
          signal: new AbortController().signal,
          publish: (frames) => {
            values.push(...frames.values[0]!)
          },
        },
        'csv',
        64,
        layout,
      )
      return values
    }
    expect(await page('time,Bus_A_Vm\n0,1.5\n')).toEqual([1.5])
    const plan = layout.plan
    // A later page's header is not matched name by name again: the first's layout stands.
    expect(await page('time,unmatched\n0.01,1.25\n')).toEqual([1.25])
    expect(layout.plan).toBe(plan)
  })

  it('evicts within budget and reloads exact native-file windows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gridkit-results-test-'))
    try {
      const kase = await Case.parse(
        '{"buses":[{"class":"Bus","number":1,"name":"A"}]}',
        catalogOf(JSON.stringify(catalogJson)),
      )
      const outputs = [{ from: 'Bus', select: ['Vm'] }]
      const fields = selections(kase, outputs)
      const path = join(directory, 'results.csv')
      await writeFile(
        path,
        'time,Bus_A_Vm\n' +
          Array.from({ length: 200 }, (_, i) => `${i / 100},${1 + i / 1000}\n`).join(''),
      )
      const info: RunInfo = {
        id: 'test',
        revision: { uri: 'file:///case', version: 1 },
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
      const cache = new ResultCache(1500)
      const results = new Results(info, kase, fields, cache)
      await results.ingest(
        new AbortController().signal,
        () => true,
        async () => {},
      )
      expect(info.frames).toBe(200)
      expect(results.pages.length).toBe(4)
      expect(cache.bytes).toBeLessThanOrEqual(1500)
      const data = await results.data([0, 0.1], new AbortController().signal)
      const blocks = []
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
        blocks.push(block)
      expect(blocks.length).toBeGreaterThan(0)
      expect(blocks[0]!.columns.Vm!.values[0]).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
