import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'

import { blockBuffers, type Data, read, rowCount, selectBatches, staticFields } from '@latkit/model'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { Case, catalog } from '../gridkit/index.js'
import type { SamplesInput } from '../shared/messages.js'
import { ResultCache } from './cache.js'
import { chunkFrames, type Layout, readResults } from './decode.js'
import { ResultsFile } from './file.js'
import type { Writer } from './follow.js'
import { CHUNK_BYTES, PROGRESS_MS } from './limits.js'
import { type Store, Stores } from './store.js'

const HEADER = 'time,Bus_A_Vm\n'
/** Room for every chunk a test reads. */
const ROOM = 256 << 20
const signal = new AbortController().signal
let kase: Case
let directory: string
let stores: Stores
/** A finished file of a few chunks, with a blank row partway and no newline after its last. */
const large = { path: '', rows: 700_000 }

beforeAll(async () => {
  kase = await Case.parse('{"buses":[{"class":"Bus","number":1,"name":"A"}]}', catalog)
  directory = await mkdtemp(join(tmpdir(), 'gridkit-results-test-'))
  stores = new Stores(join(directory, 'stores'))
  large.path = join(directory, 'large.csv')
  const rows = Array.from({ length: large.rows }, (_, i) => `${i / 1000},${1 + (i % 1000) / 1e4}`)
  rows[1000] = '\n' + rows[1000]
  await writeFile(large.path, HEADER + rows.join('\n'))
})
/** Every store a test made, each closed once the tests are done. */
const made: Store[] = []
afterAll(async () => {
  await Promise.all(made.map((store) => store.close()))
  await rm(directory, { recursive: true, force: true })
})

/** What a reading of results is of: the case revision. */
const READING = { revision: { uri: 'file:///case', version: 1 } }

/** A reading of the CSV results at `path` for `of`, kept in a store of its own. */
async function file(path: string, cache = new ResultCache(ROOM), of = kase): Promise<ResultsFile> {
  const store = await stores.create(path)
  made.push(store)
  return new ResultsFile(of, cache, store, { ...READING, path })
}

/** `results` read to the end of their file, as one opened alone is. */
async function readThrough(results: ResultsFile, writer: Writer = 'done'): Promise<ResultsFile> {
  await results.ingest(
    signal,
    () => writer,
    () => {},
  )
  return results
}

/** Reads `results` while its file grows, until `end` says the writer is done. */
function following(results: ResultsFile, progress = () => {}) {
  let writer: Writer = 'writing'
  const reading = results.ingest(signal, () => writer, progress)
  return {
    /** Waits until the reader holds `frames` frames. */
    reach: (frames: number) =>
      vi.waitFor(() => expect(results.progress.frames).toBe(frames), { timeout: 5000 }),
    end: () => {
      writer = 'done'
      return reading
    },
  }
}

/** What a view lacking `held` of the bus's Vm over `window` is sent. */
function asked(
  results: ResultsFile,
  window: [number, number],
  held: Record<number, number> = {},
  bytes = Infinity,
) {
  const input: SamplesInput = {
    results: 'results',
    field: { from: 'Bus', select: ['Vm'] },
    window,
    held,
    bytes,
  }
  return results.samples(input, signal)
}

/** `value` with each typed array as its bytes, which compare exactly and at once: equality walks a
 *  typed array one index at a time. */
function exact(value: unknown): unknown {
  if (ArrayBuffer.isView(value))
    return `${value.constructor.name} ${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')}`
  if (Array.isArray(value)) return value.map(exact)
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, exact(inner)]))
  return value
}

/** Each batch's frames, as `[first frame, count]`, and the values of the first row. */
const framesOf = (batches: readonly Data.SampleBatch[]) =>
  batches.map((batch) => [batch.firstFrame, batch.coordinates.length])
function valuesOf(batches: readonly Data.SampleBatch[]) {
  const values: number[] = []
  for (const batch of batches) {
    const column = batch.columns.Vm!
    for (let t = 0; t < batch.coordinates.length; t++)
      values.push(column.values[column.offset + t * column.frameStride]!)
    expect(rowCount(batch.rows)).toBe(1)
  }
  return values
}

describe('native results and ownership', () => {
  it('owned query buffers can transfer without detaching retained case data', async () => {
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

  it('reads every segment of a file with the layout its header gave the first', async () => {
    const layout: Layout = {}
    const segment = async (text: string) => {
      const values: number[] = []
      await readResults(
        Readable.from([Buffer.from(text)]),
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
    expect(await segment('time,Bus_A_Vm\n0,1.5\n')).toEqual([1.5])
    const learned = layout.read
    // A later segment is rows alone: the header is not read, or matched name by name, again.
    expect(await segment('0.01,1.25\n')).toEqual([1.25])
    expect(layout.read).toBe(learned)
  })

  it('learns what a file holds from its header, whatever order GridKit wrote it in', async () => {
    const two = await Case.parse(
      '{"buses":[{"class":"Bus","number":1,"name":"A"},{"class":"Bus","number":2,"name":"B"}]}',
      catalog,
    )
    const path = join(directory, 'header.csv')
    await writeFile(path, 'time,Bus_B_Vm,Bus_A_Va,"Other_x_y",bus_a_vm\n0,1.2,0.5,9,1.1\n')
    const results = await readThrough(await file(path, new ResultCache(ROOM), two))
    // Each output in catalog and row order, matched by name whatever its case, and a column the
    // case has no output for left unread. Each names its rows as the case numbers them.
    expect(results.layout.outputs).toMatchObject([
      { from: 'Bus', select: ['Vm'], rows: { kind: 'range', offset: 0, count: 2 } },
      { from: 'Bus', select: ['Va'], rows: { kind: 'range', offset: 0, count: 1 } },
    ])
    expect(results.progress.domains).toEqual({ Bus: { Vm: [1.1, 1.2], Va: [0.5, 0.5] } })
    const unknown = join(directory, 'unknown.csv')
    await writeFile(unknown, 'time,Other_x_y\n0,1\n')
    await expect(readThrough(await file(unknown, new ResultCache(ROOM), two))).rejects.toThrow(
      'No result columns match this case',
    )
  })

  it('sends the rows a view names, of those the file holds, reading only those of its store', async () => {
    const three = await Case.parse(
      JSON.stringify({
        buses: ['A', 'B', 'C'].map((name, i) => ({ class: 'Bus', number: i + 1, name })),
      }),
      catalog,
    )
    const path = join(directory, 'rows.csv')
    await writeFile(path, 'time,Bus_A_Vm,Bus_C_Vm\n0,1.1,1.3\n0.01,1.2,1.4\n')
    // With nothing kept, every read is of the store.
    const results = await readThrough(await file(path, new ResultCache(0), three))
    const reads = vi.spyOn(results.store, 'read')
    const named = async (ids?: string[]) =>
      results.samples(
        {
          results: 'results',
          field: { from: 'Bus', select: ['Vm'], ...(ids && { rows: { kind: 'ids', ids } }) },
          window: [0, 0.01],
          held: {},
          bytes: Infinity,
        },
        signal,
      )
    const [all] = await named()
    expect(all!.rows).toEqual({ kind: 'indices', values: Uint32Array.of(0, 2) })
    expect(Array.from(all!.columns.Vm!.values)).toEqual([1.1, 1.3, 1.2, 1.4])
    // Bus B is not in the file: of the rows named, only Bus C comes, and only its row is read.
    const [some] = await named(['Bus/2', 'Bus/3'])
    expect(some!.rows).toEqual({ kind: 'range', offset: 2, count: 1 })
    expect(Array.from(some!.columns.Vm!.values)).toEqual([1.3, 1.4])
    expect(reads).toHaveBeenLastCalledWith(0, 0, 2, Uint32Array.of(1))
    expect(await named(['Bus/2'])).toEqual([])
  })

  it('cuts a file into chunks of a size its header sets, which a view asks for whole', async () => {
    const results = await readThrough(await file(large.path))
    const { chunk } = results.layout
    const { frames } = results.progress
    expect(frames).toBe(large.rows)
    expect(chunk).toBeGreaterThan(1)
    expect(frames).toBeGreaterThan(2 * chunk)
    expect(results.progress.domains).toEqual({ Bus: { Vm: [1, 1.0999] } })
    // A moment inside the first chunk brings that chunk, all of it.
    expect(framesOf(await asked(results, [0.5, 0.5]))).toEqual([[0, chunk]])
    // A window across chunks brings each, less what the view holds of them.
    const across = (2 * chunk - 10) / 1000
    expect(framesOf(await asked(results, [0, across], { 0: chunk, 1: chunk - 5 }))).toEqual([
      [2 * chunk - 5, 5],
    ])
    // The last chunk ends with the file.
    const last = await asked(results, [frames / 1000, frames / 1000])
    expect(framesOf(last)).toEqual([[2 * chunk, frames - 2 * chunk]])
    expect(valuesOf(last).at(-1)).toBe(1 + ((frames - 1) % 1000) / 1e4)
  })

  it('reads the whole rows of a file whose writer stopped partway through its last', async () => {
    const path = join(directory, 'stopped.csv')
    await writeFile(path, HEADER + '0,1\n0.01,1.5\n0.02,')
    const results = await readThrough(await file(path))
    expect(results.progress.frames).toBe(2)
    expect(valuesOf(await asked(results, [0, 0.01]))).toEqual([1, 1.5])
  })

  it('leaves out a value its writer was stopped partway through, which would read as a number', async () => {
    const path = join(directory, 'cut.csv')
    // The writer stopped inside `1.25e-01`, leaving what reads as 1.25.
    await writeFile(path, HEADER + '0,1\n0.01,1.25')
    const stopped = await readThrough(await file(path), 'stopped')
    expect(stopped.progress.frames).toBe(1)
    expect(stopped.progress.domains).toEqual({ Bus: { Vm: [1, 1] } })
    // A writer that finished wrote its last row whole, newline or not.
    expect((await readThrough(await file(path), 'done')).progress.frames).toBe(2)
  })

  it('counts the bytes each chunk keeps of its own against the cache', async () => {
    const cache = new ResultCache(ROOM)
    const results = await readThrough(await file(large.path, cache))
    // One value per frame, of every chunk once the file is read through: their times are the
    // file's, which every chunk shares.
    const { chunk } = results.layout
    const { frames } = results.progress
    expect(cache.bytes).toBe(frames * 8)
    // A lower limit lets go of what is past it at once, the least recently used first: the last
    // chunk, read last, stays.
    cache.limit = chunk * 8
    expect(cache.bytes).toBe((frames % chunk) * 8)
    cache.limit = 0
    expect(cache.bytes).toBe(0)
  })

  it('reads what it read from its store, with its file gone or written again', async () => {
    const path = join(directory, 'kept.csv')
    await writeFile(path, HEADER + '0,1\n0.01,1.5\n0.02,1.25\n')
    // Nothing kept in the cache, so every read is of the store.
    const results = await readThrough(await file(path, new ResultCache(0)))
    // Another run writes the same file, as long, with other values.
    await writeFile(path, HEADER + '0,9\n0.01,9\n0.02,9\n')
    expect(valuesOf(await asked(results, [0, 0.02]))).toEqual([1, 1.5, 1.25])
    await rm(path)
    expect(valuesOf(await asked(results, [0, 0.02]))).toEqual([1, 1.5, 1.25])
  })

  it('reads a store read through alone, as a window opened again does', async () => {
    const path = join(directory, 'stored.csv')
    await writeFile(path, HEADER + '0,1\n0.01,1.5\n0.02,1.25\n')
    const first = await readThrough(await file(path))
    const manifest = first.store.manifest
    expect(manifest).toMatchObject({ path, frames: 3, header: ['time', 'Bus_A_Vm'] })
    const again = await ResultsFile.stored(kase, new ResultCache(0), first.store, {
      ...READING,
      path,
    })
    expect(again.layout).toEqual(first.layout)
    expect(again.progress).toEqual(first.progress)
    expect(valuesOf(await asked(again, [0, 0.02]))).toEqual([1, 1.5, 1.25])
    expect(again.step(0, 1)).toBe(0.01)
    // A file written to after it was read through is read again whole when opened again.
    const growing = join(directory, 'written.csv')
    await writeFile(growing, HEADER + '0,1\n')
    const results = await file(growing)
    const reader = following(results)
    await reader.reach(1)
    await appendFile(growing, '0.01,1.5\n')
    await reader.reach(2)
    await reader.end()
    expect(results.store.manifest).toMatchObject({ frames: 2 })
  })

  it('exports what it read, byte for byte, and never a file written again since', async () => {
    const path = join(directory, 'exported.csv')
    // A writer stopped partway through its last row: the export holds the whole rows read.
    await writeFile(path, HEADER + '0,1\n0.01,1.5\n0.02,')
    const results = await readThrough(await file(path), 'stopped')
    const out = join(directory, 'exports')
    await results.exportCsv(join(out, 'copy.csv'))
    expect(await readFile(join(out, 'copy.csv'), 'utf8')).toBe(HEADER + '0,1\n0.01,1.5\n')
    // Read again from its store alone, as a window opened again reads it, it exports the same.
    const again = await ResultsFile.stored(kase, new ResultCache(0), results.store, {
      ...READING,
      path,
    })
    await again.exportCsv(join(out, 'again.csv'))
    expect(await readFile(join(out, 'again.csv'), 'utf8')).toBe(HEADER + '0,1\n0.01,1.5\n')
    // Written again as long, its time set back: what it holds now was never read.
    await setTimeout(20)
    const { mtime } = await stat(path)
    await writeFile(path, HEADER + '0,9\n0.01,9.5\n0.02,')
    await utimes(path, mtime, mtime)
    await expect(results.exportCsv(join(out, 'refused.csv'))).rejects.toThrow('written again')
    // A copy refused leaves nothing behind.
    expect((await readdir(out)).sort()).toEqual(['again.csv', 'copy.csv'])
  })

  it('sends a growing chunk only the frames the view lacks of it', async () => {
    const path = join(directory, 'growing.csv')
    await writeFile(path, HEADER + '0,1\n0.01,1.1\n0.02,1.2\n')
    const results = await file(path)
    const reader = following(results)
    await reader.reach(3)
    expect(valuesOf(await asked(results, [0, 0.02]))).toEqual([1, 1.1, 1.2])
    // A row the writer is partway through waits for its end.
    await appendFile(path, '0.03,1.3\n0.04,1.')
    await reader.reach(4)
    await appendFile(path, '4\n')
    await reader.end()
    expect(results.progress.frames).toBe(5)
    const more = await asked(results, [0, 0.04], { 0: 3 })
    expect(framesOf(more)).toEqual([[3, 2]])
    expect(valuesOf(more)).toEqual([1.3, 1.4])
    const data = await results.data([0.04, 0.04], signal)
    const values = []
    for await (const block of read(data, {
      kind: 'samples',
      from: 'Bus',
      select: ['Vm'],
      window: { kind: 'range', between: [0, 0.04] },
    }))
      values.push(...block.columns.Vm!.values)
    expect(values).toEqual([1, 1.1, 1.2, 1.3, 1.4])
  })

  it('tells of a run that writes on and on no oftener than the views hear of it', async () => {
    const path = join(directory, 'busy.csv')
    await writeFile(path, HEADER)
    const results = await file(path)
    let told = 0
    const reader = following(results, () => {
      told++
    })
    const started = performance.now()
    let frames = 0
    while (performance.now() - started < 500) {
      await appendFile(path, `${frames / 1000},1\n`)
      frames++
      await setTimeout(5)
    }
    await reader.reach(frames)
    const elapsed = performance.now() - started
    await reader.end()
    // The first rows at once, then each time the views would hear, however often GridKit writes.
    expect(told).toBeGreaterThan(1)
    expect(told).toBeLessThanOrEqual(Math.ceil(elapsed / PROGRESS_MS) + 1)
  })

  it('steps between frames from the times it read, with the file gone', async () => {
    const path = join(directory, 'steps.csv')
    await writeFile(path, HEADER)
    const results = await file(path)
    const reader = following(results)
    // A fault's boundaries repeat their times, here across reads.
    let frames = 0
    for (const rows of ['0,1\n0.01,1\n0.02,1\n', '0.02,0.5\n0.03,0.5\n', '0.03,1\n0.04,1\n']) {
      await appendFile(path, rows)
      await reader.reach((frames += rows.split('\n').length - 1))
    }
    await reader.end()
    await rm(path)
    const times = [0, 0.01, 0.02, 0.02, 0.03, 0.03, 0.04]
    for (const at of [-1, ...times, 0.005, 0.025, 0.035, 1]) {
      expect(results.step(at, 1)).toBe(times.find((time) => time > at) ?? 0.04)
      expect(results.step(at, -1)).toBe(times.findLast((time) => time < at) ?? 0)
    }
  })

  it('reads a chunk its cache let go of again from its store, exactly', async () => {
    const cache = new ResultCache(1 << 20)
    const results = await readThrough(await file(large.path, cache))
    // Too large for the cache, the whole chunks are read again from the store when a view asks.
    expect(cache.bytes).toBeLessThanOrEqual(1 << 20)
    const { chunk } = results.layout
    const values = valuesOf(await asked(results, [chunk / 1000, chunk / 1000]))
    expect(values).toHaveLength(chunk)
    expect(values.slice(0, 3)).toEqual([0, 1, 2].map((i) => 1 + ((chunk + i) % 1000) / 1e4))
    // Reading an early window again never shrinks the whole file's ranges.
    expect(results.progress.domains).toEqual({ Bus: { Vm: [1, 1.0999] } })
  })

  it('reads a chunk once for views that ask for it at once', async () => {
    const results = await readThrough(await file(large.path, new ResultCache(0)))
    const reads = vi.spyOn(results.store, 'read')
    const { chunk } = results.layout
    const [a, b] = await Promise.all([
      asked(results, [chunk / 1000, chunk / 1000]),
      results.data([chunk / 1000, chunk / 1000], signal),
    ])
    expect(reads).toHaveBeenCalledOnce()
    expect(framesOf(a)).toEqual([[chunk, chunk]])
    expect(b).toBeDefined()
  })

  it('reads a field again alone exactly as it read it beside the others', async () => {
    const two = await Case.parse(
      '{"buses":[{"class":"Bus","number":1,"name":"A"},{"class":"Bus","number":2,"name":"B"}]}',
      catalog,
    )
    const path = join(directory, 'wide.csv')
    // A chunk and a half of frames, each the time and four values.
    const frames = Math.ceil((1.5 * CHUNK_BYTES) / (8 * 5))
    const rows = Array.from(
      { length: frames },
      (_, i) => `${i / 1000},${1 + i / 1e6},${i / 1e5},${0.9 + i / 1e6},${-i / 1e5}`,
    )
    await writeFile(path, 'time,Bus_A_Vm,Bus_A_Va,Bus_B_Vm,Bus_B_Va\n' + rows.join('\n'))
    const both = async (cache: ResultCache) => {
      const results = await readThrough(await file(path, cache, two))
      expect(Math.ceil(frames / results.layout.chunk)).toBeGreaterThan(1)
      return Promise.all(
        ['Vm', 'Va'].map((field) =>
          results.samples(
            {
              results: 'results',
              field: { from: 'Bus', select: [field] },
              window: [0, frames / 1000],
              held: {},
              bytes: Infinity,
            },
            signal,
          ),
        ),
      )
    }
    // Every chunk kept as the file was read, against each field read again alone from the store.
    const [kept, again] = await Promise.all([both(new ResultCache(ROOM)), both(new ResultCache(0))])
    expect(exact(again)).toEqual(exact(kept))
    expect(kept[1]![0]!.columns.Va).toBeDefined()
  })

  it('sends about as many bytes as asked, a chunk at least, nearest first', async () => {
    const results = await readThrough(await file(large.path))
    const { chunk } = results.layout
    const { frames } = results.progress
    const end = (frames - 1) / 1000
    const one = await asked(results, [0, end], {}, 1)
    expect(framesOf(one)).toEqual([[0, chunk]])
    const near = await results.samples(
      {
        results: 'results',
        field: { from: 'Bus', select: ['Vm'] },
        window: [0, end],
        held: {},
        near: { at: end, travel: 0 },
        bytes: 1,
      },
      signal,
    )
    expect(near[0]!.firstFrame).toBe(2 * chunk)
    expect(chunk).toBe(chunkFrames(results.fields))
  })
})
