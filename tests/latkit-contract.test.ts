import { createRequire } from 'node:module'

import { Data, field, Patch, reference } from 'latkit'
import { beforeAll, describe, expect, it } from 'vitest'

import type { ProjectedDocument } from '../src/gridkit/document.js'
import { CaseQueries, project, projectionPage } from '../src/gridkit/projection.js'
import { framePatch, initializeFrames, rawRun, visualValues } from '../src/results/frames.js'
import { Pyramid, type ReducedRun } from '../src/results/pyramid.js'
import { DatasetSlot } from '../src/webview/datasets.js'
import { loadNative } from '../src/workers/native.js'
import { transferables } from '../src/workers/transfer.js'

const require = createRequire(import.meta.url)
const wasmPath = require.resolve('latkit/wasm')
const signal = AbortSignal.any([])

beforeAll(async () => {
  await expect(loadNative(`${wasmPath}.missing`)).rejects.toThrow()
  const first = loadNative(wasmPath)
  expect(loadNative(wasmPath)).toBe(first)
  await first
  await expect(loadNative(`${wasmPath}.other`)).rejects.toThrow('another WASM')
})

describe('published Latkit 0.3.1 WASM', () => {
  it('preserves native IDs, punctuation, references, and float64 static values', () => {
    using data = new Data('case')
    data.apply(
      new Patch('case')
        .replace('Bus', [1, 2], { voltage: Float64Array.of(Math.PI, 2) })
        .replace('Device', ['a/b', 'a:1'], { bus: reference('Bus', [2, 1]) }),
    )
    expect(data.get('Bus', 1, 'voltage')).toBe(Math.PI)
    const page = data.query({ of: 'Device', select: { bus: field('bus') } })
    expect(page.ids).toEqual(['a/b', 'a:1'])
    expect(page.fields.bus).toEqual({ reference: 'Bus', ids: [2, 1] })
  })

  it('populates initially null columns and returns native filtered/sorted totals', () => {
    using data = new Data('case')
    data.replace('Bus', [1, 2, 3], { label: [null, null, null], value: [3, 1, 2] })
    data.set('Bus', [1, 2, 3], { label: ['North', 'South', 'Northwest'] })
    const result = data.query({
      of: 'Bus',
      filter: field('label').contains('North'),
      sort: [[field('value'), 'ascending']],
      offset: 1,
      limit: 1,
      select: { value: field('value') },
    })
    expect(result.ids).toEqual([1])
    expect(result.total).toBe(2)
    expect(result.fields.value).toEqual(Float64Array.of(3))
  })

  it('restores independent snapshots and retains a snapshot after dataset destruction', () => {
    const original = new Data('case').replace('Bus', [1], { value: [1] })
    using snapshot = original.snapshot()
    using copy = new Data('case').restore(snapshot)
    original.set('Bus', [1], { value: [2] })
    copy.set('Bus', [1], { value: [3] })
    expect(original.get('Bus', 1, 'value')).toBe(2)
    expect(copy.get('Bus', 1, 'value')).toBe(3)
    original.destroy()
    original.destroy()
    expect(snapshot.get('Bus', 1, 'value')).toBe(1)
  })

  it('uses sparse frame entries and float32 visualization without changing raw values', () => {
    using data = new Data('sample')
    data.apply(initializeFrames('sample', 'Bus', [2]))
    const values = Float64Array.of(Math.PI, NaN, 7)
    data.apply(
      framePatch(
        'sample',
        'Bus',
        'Vm',
        rawRun({
          first: 100,
          at: Float64Array.of(0.1, 0.1, 1.7),
          rows: 1,
          values,
        }),
      ),
    )
    expect(values[0]).toBe(Math.PI)
    expect(data.get('Bus', 2, 'Vm', { at: 1.7 })).toBe(7)
    expect(() => data.frames('Bus', 'Vm', { first: 100, at: [0.1], values: [1] })).toThrow()
    expect(visualValues(Float64Array.of(Math.PI))[0]).toBe(Math.fround(Math.PI))
    expect(() => visualValues(Float64Array.of(Number.MAX_VALUE))).toThrow('float32')
  })
})

const document: ProjectedDocument = {
  key: 'revision-1',
  definition: {
    tables: [
      {
        name: 'Bus',
        label: 'Bus',
        identity: 'id',
        labelField: '@studio.label',
        fields: [
          { name: '@studio.label', kind: 'text', label: 'Name' },
          { name: 'v', kind: 'number', label: 'Voltage' },
        ],
      },
      {
        name: 'Device',
        label: 'Device',
        identity: 'id',
        labelField: 'id',
        fields: [{ name: 'bus', kind: 'reference', label: 'Bus', target: 'Bus' }],
      },
    ],
    drawing: { geographic: false, vertices: [], edges: [], blocks: [], nets: [] },
  },
  tables: new Map([
    [
      'Bus',
      {
        ids: [1, 2],
        read: (name: string, offset: number, count: number) =>
          (name === 'v' ? Float64Array.of(Math.PI, 2) : ['North', 'South']).slice(
            offset,
            offset + count,
          ),
      },
    ],
    ['Device', { ids: ['a/b'], read: () => reference('Bus', [2]) }],
  ]),
}

it('projects reference identities before fields and queries lazily', async () => {
  using data = new Data('case')
  for await (const bytes of project(document, new Map([['Device', ['bus']]]), signal))
    data.apply(bytes)
  expect(data.get('Device', 'a/b', 'bus')).toEqual(2)
  expect(data.query({ of: 'Bus' }).ids).toEqual([1, 2])
  const queries = new CaseQueries(document)
  try {
    const page = await queries.page(
      { table: 'Bus', fields: ['v'], offset: 0, limit: 1, search: 'North' },
      signal,
    )
    expect(page.total).toBe(1)
    expect(page.fields.v).toEqual(Float64Array.of(Math.PI))
  } finally {
    queries.destroy()
  }
  await expect(
    projectionPage(document, [{ table: 'Bus', fields: ['missing'] }], undefined, signal),
  ).rejects.toThrow('Unknown field')
})

async function* patches(...values: Uint8Array[]) {
  yield* values
}

it('queries typed fields in empty tables and rejects filtered source-order anchors', async () => {
  const empty: ProjectedDocument = {
    ...document,
    tables: new Map([
      ['Bus', { ids: [], read: (name: string) => (name === 'v' ? new Float64Array() : []) }],
      ['Device', { ids: [], read: () => reference('Bus', []) }],
    ]),
  }
  const queries = new CaseQueries(empty)
  try {
    const page = await queries.page({ table: 'Bus', fields: ['v'], offset: 0, limit: 10 }, signal)
    expect(page.ids).toEqual([])
    expect(page.total).toBe(0)
    expect(page.fields.v).toEqual(new Float64Array())
    const references = await queries.page(
      { table: 'Device', fields: ['bus'], offset: 0, limit: 10 },
      signal,
    )
    expect(references.fields.bus).toEqual({ reference: 'Bus', ids: [] })
    await expect(
      queries.page(
        { table: 'Bus', fields: ['v'], offset: 0, limit: 10, anchor: 1, search: 'A' },
        signal,
      ),
    ).rejects.toThrow('source order')
  } finally {
    queries.destroy()
  }
})

it('keeps the complete displayed revision on failure, cancellation, and late completion', async () => {
  const slot = new DatasetSlot()
  const first = new Patch('case').replace('Bus', [1], { v: [1] }).toBytes()
  try {
    await slot.receive('case', 'a', patches(first), signal)
    await expect(slot.receive('case', 'b', patches(Uint8Array.of(1, 2)), signal)).rejects.toThrow()
    expect(slot.current?.key).toBe('a')
    let resolve!: () => void
    const wait = {
      promise: new Promise<void>((done) => {
        resolve = done
      }),
      resolve: () => resolve(),
    }
    async function* delayed() {
      await wait.promise
      yield first
    }
    const old = slot.receive('case', 'late', delayed(), signal)
    await slot.receive(
      'case',
      'c',
      patches(new Patch('case').set('Bus', [1], { v: [3] }).toBytes()),
      signal,
      'a',
    )
    wait.resolve()
    expect(await old).toBe(false)
    expect(slot.current?.key).toBe('c')
    expect(slot.current?.data.get('Bus', 1, 'v')).toBe(3)
    const abort = new AbortController()
    abort.abort()
    await expect(slot.receive('case', 'd', patches(first), abort.signal)).rejects.toThrow()
    expect(slot.current?.key).toBe('c')
  } finally {
    slot.clear()
  }
})

it('reduces exact eight-way boundaries with irregular times, gaps, and restart tails', () => {
  const expected: ReducedRun[] = []
  const actual: ReducedRun[] = []
  const times = Float64Array.from({ length: 71 }, (_, i) => Math.floor(i / 2) ** 2)
  const values = Float64Array.from(times, (_, i) => (i === 19 ? NaN : i === 20 ? 1000 : i))
  new Pyramid(1, (run) => expected.push(run)).push(0, times, values)
  const first = new Pyramid(1, (run) => actual.push(run))
  first.push(0, times.slice(0, 37), values.slice(0, 37))
  const second = new Pyramid(1, (run) => actual.push(run))
  second.restore(JSON.parse(JSON.stringify(first.snapshot())))
  second.push(37, times.slice(37), values.slice(37))
  expect(actual).toEqual(expected)
  expect(actual.filter((run) => run.level === 1)).toHaveLength(8)
  expect(actual.find((run) => run.level === 2)?.values).toEqual(Float32Array.of(0, 1000))
  expect(actual.find((run) => run.level === 1 && run.first === 2)?.gaps[0]).toBe(1)
})

it('transfers each owned backing buffer once, even with cycles', () => {
  const bytes = new Uint8Array(8)
  const reply: { bytes: Uint8Array; copy: Uint8Array; self?: unknown } = {
    bytes,
    copy: bytes.subarray(2),
  }
  reply.self = reply
  expect(transferables(reply)).toEqual([bytes.buffer])
})
