import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'

import { Data } from 'latkit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { Case, catalog } from '../gridkit/index.js'
import type { FrameRequest } from '../shared/data.js'
import { loadNative } from '../workers/native.js'
import { ResultCache } from './cache.js'
import { type Layout, readResults } from './decode.js'
import { ResultsFile } from './file.js'
import type { Writer } from './follow.js'
import { PROGRESS_MS } from './limits.js'
import { Store, Stores } from './store.js'

const signal = AbortSignal.any([])
const HEADER = 'time,Bus_A_Vm\n'
let directory: string
let stores: Stores
let kase: Case
const made: ResultsFile[] = []
beforeAll(async () => {
  await loadNative(createRequire(import.meta.url).resolve('latkit/wasm'))
  directory = await mkdtemp(join(tmpdir(), 'native-results-file-'))
  stores = new Stores(join(directory, 'cache'))
  kase = await Case.parse('{"buses":[{"class":"Bus","number":1,"name":"A"}]}', catalog)
})
afterAll(async () => {
  for (const file of made) {
    await file.retire()
    await file.store.close()
  }
  await rm(directory, { recursive: true, force: true })
})
const reading = (path: string) => ({ path, revision: { uri: 'file:///case', version: 1 } })
async function create(name: string, csv: string, of = kase) {
  const path = join(directory, name + '.csv')
  await writeFile(path, csv)
  const file = new ResultsFile(of, new ResultCache(0), await stores.create(path), reading(path))
  made.push(file)
  return file
}
async function through(file: ResultsFile, writer: Writer = 'done') {
  await file.ingest(
    signal,
    () => writer,
    () => {},
  )
  return file
}
function following(file: ResultsFile, progress = () => {}) {
  let writer: Writer = 'writing'
  const done = file.ingest(signal, () => writer, progress)
  return {
    reach: (frames: number) => vi.waitFor(() => expect(file.progress.frames).toBe(frames)),
    end: () => {
      writer = 'done'
      return done
    },
  }
}
function request(file: ResultsFile, more: Partial<FrameRequest> = {}): FrameRequest {
  return {
    results: 'test',
    table: 'Bus',
    field: 'Vm',
    range: file.progress.domain,
    purpose: 'playhead',
    pixels: 1000,
    bytes: 8 << 20,
    ...more,
  }
}
async function capture(file: ResultsFile, input = request(file)) {
  let next: string | undefined
  let data: Data | undefined
  let bytes = 0
  try {
    do {
      const page = await file.frames({ ...input, next }, signal)
      data ??= new Data(page.source)
      data.apply(page.bytes)
      expect(page.bytes.byteLength).toBeLessThanOrEqual(4 << 20)
      bytes += page.bytes.byteLength
      next = page.next
    } while (next)
    return { data: data!, bytes }
  } catch (error) {
    data?.destroy()
    throw error
  }
}
const exact = (file: ResultsFile, at: number, id = 1, field = 'Vm') =>
  file.sample({ results: 'test', table: 'Bus', field, id, at }, signal)

describe('indexed scientific results', () => {
  it('learns the CSV layout once across segments', async () => {
    const layout: Layout = {}
    const segment = async (csv: string) => {
      const values: number[] = []
      await readResults(
        Readable.from([Buffer.from(csv)]),
        kase,
        {
          signal,
          publish: (frames) => {
            values.push(...frames.values[0]!)
          },
        },
        layout,
      )
      return values
    }
    expect(await segment(HEADER + '0,1.5\n')).toEqual([1.5])
    const learned = layout.read
    expect(await segment('0.01,1.25\n')).toEqual([1.25])
    expect(layout.read).toBe(learned)
  })
  it('matches unordered sparse columns to stable numeric IDs', async () => {
    const three = await Case.parse(
      JSON.stringify({
        buses: ['A', 'B', 'C'].map((name, i) => ({ class: 'Bus', number: i + 1, name })),
      }),
      catalog,
    )
    const file = await through(
      await create(
        'sparse',
        'time,Bus_C_Vm,Bus_A_Va,Other_x_y,bus_a_vm\n0,1.3,0.5,9,1.1\n1,1.4,0.6,9,1.2\n',
        three,
      ),
    )
    expect(file.layout.outputs).toEqual([
      { table: 'Bus', field: 'Vm', ids: [1, 3] },
      { table: 'Bus', field: 'Va', ids: [1] },
    ])
    const read = vi.spyOn(file.store, 'readRaw')
    const { data } = await capture(file, request(file, { ids: [3] }))
    using held = data
    expect(held.name).toBeTruthy()
    expect(held.name).toBe(data.name)
    expect(data.query({ of: 'Bus' }).ids).toEqual([3])
    expect(data.get('Bus', 3, 'Vm', { at: 0 })).toBe(Math.fround(1.3))
    expect(read.mock.calls.every(([, , rows]) => JSON.stringify(rows) === '[1]')).toBe(true)
    expect((await exact(file, 0, 3)).value).toBe(1.3)
    expect((await exact(file, 0, 2)).value).toBeNull()
    await expect(capture(file, request(file, { ids: [2] }))).rejects.toThrow('not recorded')
    await expect(through(await create('unmatched', 'time,Other_x_y\n0,1\n'))).rejects.toThrow(
      'No result columns match',
    )
  })
  it('reads bracketing frames by timestamps instead of sending a whole disk block', async () => {
    const count = 600_000
    const file = await through(
      await create(
        'long',
        HEADER + Array.from({ length: count }, (_, i) => `${i / 1000},${i % 20}\n`).join(''),
      ),
    )
    expect(file.progress.frames).toBe(count)
    expect(file.store.raw.length).toBeGreaterThan(1)
    const read = vi.spyOn(file.store, 'readRaw')
    const { data, bytes } = await capture(
      file,
      request(file, { range: [500.0005, 500.0005], bytes: 4096 }),
    )
    using held = data
    expect(held.name).toBeTruthy()
    expect(data.describe().span).toEqual([500, 500.001])
    expect(bytes).toBeLessThan(4096)
    expect(read.mock.calls.every(([, , , , frames]) => frames! <= 2)).toBe(true)
    expect(file.cache.bytes).toBe(0)
    const plot = await capture(
      file,
      request(file, { purpose: 'plot', pixels: 600, bytes: 32 << 10 }),
    )
    using overview = plot.data
    expect(plot.bytes).toBeLessThan(32 << 10)
    expect(
      overview.envelope({ table: 'Bus', field: 'Vm', range: [...file.progress.domain], spans: 1 })
        .greatest[0],
    ).toBe(19)
  })
  it('reads only complete rows after a stopped writer, and accepts an unterminated final row after success', async () => {
    const stopped = await through(await create('stopped', HEADER + '0,1\n1,1.25'), 'stopped')
    expect(stopped.progress.frames).toBe(1)
    const finished = await through(await create('finished', HEADER + '0,1\n1,1.25'))
    expect(finished.progress.frames).toBe(2)
    expect((await exact(finished, 1)).value).toBe(1.25)
    const partial = await through(await create('partial', HEADER + '0,1\n1,'))
    expect(partial.progress.frames).toBe(1)
  })
  it('keeps authoritative values and CSV after the original is replaced or deleted', async () => {
    const csv = HEADER + `0,${Math.PI}\n1,1.2345678901234567\n`
    const file = await through(await create('original', csv))
    await writeFile(file.layout.path, HEADER + '0,9\n')
    expect((await exact(file, 0)).value).toBe(Math.PI)
    await rm(file.layout.path)
    expect((await exact(file, 1)).value).toBe(1.2345678901234567)
    const out = join(directory, 'exact-export.csv')
    await file.exportCsv(out)
    expect(await readFile(out, 'utf8')).toBe(csv)
    await expect(file.exportCsv(file.layout.path)).rejects.toThrow('different file')
  })
  it('restores only committed blocks and rejects a truncated committed store', async () => {
    const file = await through(await create('restore', HEADER + '0,1\n1,2\n'))
    const { folder, key, manifest } = file.store
    await file.store.close()
    const store = new Store(folder, key, manifest)
    const reopened = await ResultsFile.stored(
      kase,
      new ResultCache(0),
      store,
      reading(file.layout.path),
    )
    made.push(reopened)
    expect(reopened.progress).toEqual(file.progress)
    expect((await exact(reopened, 1)).value).toBe(2)
    await store.close()
    await truncate(join(folder, 'raw.bin'), 8)
    const broken = new Store(folder, key, manifest)
    try {
      await expect(
        ResultsFile.stored(kase, new ResultCache(0), broken, reading(file.layout.path)),
      ).rejects.toThrow('truncated')
    } finally {
      await broken.close()
    }
  })
  it('stages fresh native windows as a live tail grows, without duplicate frame ingestion', async () => {
    const file = await create('live', HEADER + '0,1\n1,1.1\n2,1.2\n')
    const reader = following(file)
    try {
      await reader.reach(3)
      const first = await capture(file)
      using old = first.data
      await appendFile(file.layout.path, '3,1.3\n4,1.')
      await reader.reach(4)
      await appendFile(file.layout.path, '4\n')
      await reader.reach(5)
      const next = await capture(file)
      using current = next.data
      expect(old.describe().span).toEqual([0, 2])
      expect(current.describe().span).toEqual([0, 4])
      expect(current.get('Bus', 1, 'Vm', { at: 4 })).toBe(Math.fround(1.4))
    } finally {
      await reader.end()
    }
  })
  it('steps across duplicate and irregular timestamps using bounded disk reads', async () => {
    const times = [0, 0.01, 0.01, 12, 12, 100000]
    const file = await through(
      await create('irregular', HEADER + times.map((at, i) => `${at},${i}\n`).join('')),
    )
    await rm(file.layout.path)
    for (const at of [-1, ...times, 5, 20, 100001]) {
      expect(await file.step(at, 1)).toBe(times.find((time) => time > at) ?? times.at(-1))
      expect(await file.step(at, -1)).toBe(times.findLast((time) => time < at) ?? 0)
    }
    expect(await exact(file, 12)).toEqual({ at: 12, value: 4 })
  })
  it('checks cancellation before reads and rejects continuation tokens for another request', async () => {
    const file = await through(await create('cancel', HEADER + '0,1\n1,2\n'))
    const controller = new AbortController()
    controller.abort()
    const read = vi.spyOn(file.store, 'readRaw')
    await expect(file.frames(request(file), controller.signal)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    await expect(
      file.frames(
        { ...request(file), next: JSON.stringify({ key: 'other', frames: 2, part: 0, offset: 0 }) },
        signal,
      ),
    ).rejects.toThrow('window changed')
    await expect(file.frames(request(file, { bytes: 1 }), signal)).rejects.toThrow('Invalid')
  })
  it('throttles live progress and exports the last complete rows after a decoding error', async () => {
    const file = await create('progress', HEADER)
    let told = 0
    let count = 0
    const reader = following(file, () => {
      told++
    })
    const started = performance.now()
    while (performance.now() - started < 350) {
      await appendFile(file.layout.path, `${count++},1\n`)
      await setTimeout(5)
    }
    await reader.reach(count)
    const elapsed = performance.now() - started
    await appendFile(file.layout.path, `${count},bad\n`)
    await expect(reader.end()).rejects.toThrow('not a number')
    expect(told).toBeLessThanOrEqual(Math.ceil(elapsed / PROGRESS_MS) + 1)
    const out = join(directory, 'partial-export.csv')
    await file.exportCsv(out)
    expect(await readFile(out, 'utf8')).toBe(
      HEADER + Array.from({ length: count }, (_, i) => `${i},1\n`).join(''),
    )
  })
})
