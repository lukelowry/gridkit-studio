import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { Data, type Id } from 'latkit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { Case, catalog } from '../gridkit/index.js'
import { type FrameRequest, PAGE_BYTES, type TileRequest, type TimeRange } from '../shared/data.js'
import { loadNative } from '../workers/native.js'
import { type Layout, readResults } from './decode.js'
import { ResultsFile } from './file.js'
import type { Writer } from './follow.js'
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
  kase = await Case.parse(
    new TextEncoder().encode('{"buses":[{"class":"Bus","number":1,"name":"A"}]}'),
    catalog,
  )
})
afterAll(async () => {
  for (const file of made) {
    await file.retire()
    await file.store.close()
  }
  await rm(directory, { recursive: true, force: true })
})
const datasets: Data[] = []
afterAll(() => {
  for (const data of datasets) data.destroy()
})
const reading = (path: string) => ({ path, revision: { uri: 'file:///case', version: 1 } })
async function create(name: string, csv: string, of = kase) {
  const path = join(directory, name + '.csv')
  await writeFile(path, csv)
  const file = new ResultsFile(of, await stores.create(path), reading(path))
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
/** What latkit's Tiles fetch of `file`'s voltages, every row's or `id`'s: the manifest, then the
 *  base and every span of `level` (by default the manifest's highest), applied to a dataset of
 *  their own, with the bytes of those spans. */
async function tiled(file: ResultsFile, level?: number, id?: Id) {
  const ask = (tile: TileRequest['file']) =>
    file.tile(
      { results: 'test', table: 'Bus', field: 'Vm', ...(id !== undefined && { id }), file: tile },
      signal,
    )
  const manifest = JSON.parse(new TextDecoder().decode(await ask('frames.json'))) as {
    data: string
    chunk: number
    url: string
    frames: [{ table: string; field: string; levels: number; frames: [number, number] }]
  }
  const [{ levels, frames }] = manifest.frames
  const at = level ?? levels
  const data = new Data('tiles')
  datasets.push(data)
  data.apply(await ask('base.latk'))
  let bytes = 0
  for (let index = 0; index * manifest.chunk < Math.ceil(frames[1] / 8 ** at); index++) {
    const span = await ask({ level: at, index })
    bytes += span.byteLength
    data.apply(span)
  }
  return { manifest, data, bytes }
}
const envelope = (data: Data, range: TimeRange, spans = 60) =>
  data.envelope({ table: 'Bus', field: 'Vm', range: [...range], spans })
/** What a Network mapping reads of `file`'s voltages around the playhead. */
function request(
  file: ResultsFile,
  more: Partial<Pick<FrameRequest, 'ids' | 'range'>> & { bytes?: number; step?: number } = {},
): FrameRequest {
  return {
    results: 'test',
    table: 'Bus',
    field: 'Vm',
    range: file.progress.domain,
    bytes: 8 << 20,
    step: 0,
    ...more,
  }
}
async function capture(file: ResultsFile, input = request(file)) {
  let next: string | undefined
  let data: Data | undefined
  let bytes = 0
  let pages = 0
  try {
    do {
      const page = await file.frames({ ...input, next }, signal)
      data ??= new Data(page.source)
      data.apply(page.bytes)
      expect(page.bytes.byteLength).toBeLessThanOrEqual(PAGE_BYTES)
      bytes += page.bytes.byteLength
      pages++
      next = page.next
    } while (next)
    return { data: data!, bytes, pages }
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
      new TextEncoder().encode(
        JSON.stringify({
          buses: ['A', 'B', 'C'].map((name, i) => ({ class: 'Bus', number: i + 1, name })),
        }),
      ),
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
    using data = (await capture(file, request(file, { ids: [3] }))).data
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
  it('reads bracketing frames by timestamps, every frame a page at a time, and tiles a plot at any level', async () => {
    // Enough frames for several blocks on disk, and more than a page of them.
    const count = 400_000
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
      request(file, { range: [300.0005, 300.0005], bytes: 4096 }),
    )
    using held = data
    expect(held.name).toBeTruthy()
    expect(data.describe().span).toEqual([300, 300.001])
    expect(bytes).toBeLessThan(4096)
    expect(read.mock.calls.every(([, , , , frames]) => frames! <= 2)).toBe(true)
    // Every frame of it comes once and in order, however many pages that takes.
    const every = await capture(file, request(file, { bytes: 96 << 20 }))
    using all = every.data
    expect(every.pages).toBeGreaterThan(1)
    expect(all.describe().span).toEqual([0, (count - 1) / 1000])
    for (let i = 0; i < count; i += 7919)
      expect(all.get('Bus', 1, 'Vm', { at: i / 1000 })).toBe(i % 20)
    // A plot of the whole run fetches a coarse level: a sliver of every frame's bytes, which holds
    // each bucket's least and greatest value, and reaches the last frame through the bucket still
    // filling.
    const plot = await tiled(file, 4)
    expect(plot.manifest.frames[0]).toMatchObject({ levels: 6, frames: [0, count] })
    expect(plot.bytes).toBeLessThan(every.bytes / 100)
    expect(plot.data.describe().span).toEqual([0, (count - 1) / 1000])
    expect(envelope(plot.data, file.progress.domain, 1)).toMatchObject({
      least: Float32Array.of(0),
      greatest: Float32Array.of(19),
    })
    // Each span of a few rows of a wide field is about a mebibyte, so a level's spans are few.
    expect(plot.manifest.chunk % 8).toBe(0)
    expect(plot.manifest.chunk * 24).toBeLessThanOrEqual(1 << 20)
  })
  it('sends a playhead the frames it shows, as every frame would show them', async () => {
    // A frame each hundredth of a second, its value its number.
    const file = await through(
      await create(
        'stepped',
        HEADER + Array.from({ length: 101 }, (_, i) => `${i / 100},${i}\n`).join(''),
      ),
    )
    const range: TimeRange = [0.1, 0.5]
    const step = 1 / 30
    const every = await capture(file, request(file, { range }))
    const shown = await capture(file, request(file, { range, step }))
    using all = every.data
    using some = shown.data
    expect(some.describe().span![0]).toBe(0.1)
    expect(some.describe().span![1]).toBeCloseTo(0.5, 9)
    // Each time a view shows, thirty a second, it shows what every frame would.
    for (let shown = 0; range[0] + shown * step <= range[1] + 1e-9; shown++) {
      const at = range[0] + shown * step
      expect(some.get('Bus', 1, 'Vm', { at })).toBe(all.get('Bus', 1, 'Vm', { at }))
    }
    expect(shown.bytes).toBeLessThan(every.bytes)
  })
  it('keeps a missing value a gap, and draws a value float32 cannot hold as one', async () => {
    const file = await through(await create('gaps', HEADER + '0,1\n0.1,NaN\n10,5\n20,1e100\n'))
    expect((await exact(file, 20)).value).toBe(1e100)
    expect((await exact(file, 0.1)).value).toBeNull()
    const { data } = await tiled(file, 0)
    expect(data.get('Bus', 1, 'Vm', { at: 10 })).toBe(5)
    expect(data.get('Bus', 1, 'Vm', { at: 0.1 })).toBeNull()
    expect(data.get('Bus', 1, 'Vm', { at: 20 })).toBeNull()
  })
  it('tiles a missing frame as a gap, left out of the buckets above it as latkit leaves it', async () => {
    // Buckets of 512 frames, one frame of them missing, one a spike.
    const [count, missing, spike] = [8192, 4113, 6000]
    const file = await through(
      await create(
        'lone-gap',
        HEADER +
          Array.from(
            { length: count },
            (_, i) => `${i},${i === missing ? 'NaN' : i === spike ? 10000 : 1}\n`,
          ).join(''),
      ),
    )
    const range: TimeRange = [0, count - 1]
    expect((await tiled(file, 0)).data.get('Bus', 1, 'Vm', { at: missing })).toBeNull()
    const buckets = await tiled(file, 3)
    expect(envelope(buckets.data, range, 1)).toMatchObject({
      least: Float32Array.of(1),
      greatest: Float32Array.of(10000),
    })
  })
  it('tiles one row of a field alone, as a plot of one element reads it', async () => {
    const three = await Case.parse(
      new TextEncoder().encode(
        JSON.stringify({
          buses: ['A', 'B', 'C'].map((name, i) => ({ class: 'Bus', number: i + 1, name })),
        }),
      ),
      catalog,
    )
    const file = await through(
      await create(
        'one-row',
        'time,Bus_A_Vm,Bus_B_Vm,Bus_C_Vm\n' +
          Array.from({ length: 100 }, (_, i) => `${i},${i},${10 * i},${100 * i}\n`).join(''),
        three,
      ),
    )
    const all = await tiled(file, 1)
    const one = await tiled(file, 1, 2)
    expect(one.data.query({ of: 'Bus' }).ids).toEqual([2])
    expect(one.bytes).toBeLessThan(all.bytes)
    // Each row keeps its place among the rows tiled, which colors its trace.
    expect(one.data.get('Bus', 2, 'series')).toBe(0)
    expect(all.data.get('Bus', 3, 'series')).toBe(2)
    expect(envelope(one.data, [0, 99], 1).greatest).toEqual(Float32Array.of(990))
    await expect(tiled(file, 1, 7)).rejects.toThrow('not recorded')
  })
  it("tiles a live run's every frame read, each level ending in the bucket still filling", async () => {
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => `${(from + i) / 100},${((from + i) * 7) % 13}\n`)
    let written = 300
    const file = await create('live-plot', HEADER + rows(0, written).join(''))
    const reader = following(file)
    try {
      for (const frames of [300, 303, 310, 318, 330, 400, 1000, 1001]) {
        if (frames > written) {
          await appendFile(file.layout.path, rows(written, frames).join(''))
          written = frames
        }
        await reader.reach(frames)
        const end = (frames - 1) / 100
        for (const level of [0, 1, 2]) {
          const { manifest, data } = await tiled(file, level)
          expect(manifest.frames[0].frames).toEqual([0, frames])
          // Every level reaches the last frame read, and holds what every frame says.
          expect(data.describe().span).toEqual([0, end])
          expect(envelope(data, [0, end], 1)).toMatchObject({
            least: Float32Array.of(0),
            greatest: Float32Array.of(12),
          })
        }
      }
    } finally {
      await reader.end()
    }
  })
  it("reads GridKit's long layout as its wide one, an only sample whole once the file is", async () => {
    const long = 'sample,t,class,id,variable,value\n'
    const file = await through(await create('long', long + '0,0,Bus,A,Vm,1\n1,1,Bus,A,Vm,1.25\n'))
    expect(file.layout.outputs).toEqual([{ table: 'Bus', field: 'Vm', ids: [1] }])
    expect(file.progress.frames).toBe(2)
    expect((await exact(file, 1)).value).toBe(1.25)
    const only = await through(await create('long-one', long + '0,0,Bus,A,Vm,1\n'))
    expect(only.progress.frames).toBe(1)
    // A writer stopped partway leaves its only sample unfinished, as a cut wide row is.
    const stopped = await through(
      await create('long-stopped', long + '0,0,Bus,A,Vm,1\n'),
      'stopped',
    )
    expect(stopped.progress.frames).toBe(0)
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
  it('writes down what it keeps once, as its read ends, and reads on from where a read stopped short', async () => {
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => `${from + i},${from + i}\n`).join('')
    const file = await create('once', HEADER + rows(0, 3))
    const kept = vi.spyOn(file.store, 'checkpoint')
    const stop = new AbortController()
    const read = file.ingest(
      stop.signal,
      () => 'writing',
      () => {},
    )
    await vi.waitFor(() => expect(file.progress.frames).toBe(3))
    await appendFile(file.layout.path, rows(3, 6))
    await vi.waitFor(() => expect(file.progress.frames).toBe(6))
    // Segment after segment, nothing is written down: a window gone now leaves a store that says
    // nothing, and its file is read again.
    expect(kept).not.toHaveBeenCalled()
    expect(file.store.manifest).toBeUndefined()
    // Let go of partway, the read says how far it came.
    stop.abort()
    await expect(read).rejects.toThrow()
    expect(kept).toHaveBeenCalledTimes(1)
    expect(file.store.manifest).toMatchObject({ complete: false, frames: 6 })
    await appendFile(file.layout.path, rows(6, 9))
    const { folder, key, manifest } = file.store
    await file.store.close()
    const store = new Store(folder, key, manifest)
    const resumed = await ResultsFile.stored(kase, store, reading(file.layout.path))
    made.push(resumed)
    const again = vi.spyOn(store, 'checkpoint')
    await through(resumed)
    expect(resumed.progress.frames).toBe(9)
    expect((await exact(resumed, 2)).value).toBe(2)
    expect((await exact(resumed, 8)).value).toBe(8)
    expect(again).toHaveBeenCalledTimes(1)
    expect(store.manifest).toMatchObject({ complete: true, frames: 9 })
  })
  it('restores only committed blocks and rejects a truncated committed store', async () => {
    const file = await through(await create('restore', HEADER + '0,1\n1,2\n'))
    const { folder, key, manifest } = file.store
    await file.store.close()
    // What a write cut short left past what the store said it holds is no part of it.
    await appendFile(join(folder, 'raw.bin'), new Uint8Array(100))
    await appendFile(join(folder, 'levels.bin'), new Uint8Array(100))
    const store = new Store(folder, key, manifest)
    const reopened = await ResultsFile.stored(kase, store, reading(file.layout.path))
    made.push(reopened)
    expect(reopened.progress).toEqual(file.progress)
    expect((await exact(reopened, 1)).value).toBe(2)
    await store.close()
    await truncate(join(folder, 'raw.bin'), 8)
    const broken = new Store(folder, key, manifest)
    try {
      await expect(ResultsFile.stored(kase, broken, reading(file.layout.path))).rejects.toThrow(
        'truncated',
      )
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
        { ...request(file), next: JSON.stringify({ key: 'other', frames: 2, offset: 0 }) },
        signal,
      ),
    ).rejects.toThrow('window changed')
    await expect(file.frames(request(file, { bytes: 1 }), signal)).rejects.toThrow('Invalid')
  })
  it('shows and exports the rows it read before one that does not decode', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => `${i},1\n`).join('')
    const file = await create('partial', HEADER + rows)
    const reader = following(file)
    await reader.reach(40)
    // A segment that does not read is no part of the file read: neither its frames nor its bytes.
    await appendFile(file.layout.path, '40,2\n41,bad\n')
    await expect(reader.end()).rejects.toThrow('not a number')
    expect(file.progress).toMatchObject({ frames: 40, growing: false })
    expect(file.progress.error).toMatch('not a number')
    const out = join(directory, 'partial-export.csv')
    await file.exportCsv(out)
    expect(await readFile(out, 'utf8')).toBe(HEADER + rows)
  })
})
