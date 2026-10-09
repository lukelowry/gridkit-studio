import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'

import {
  blockBuffers,
  read,
  rowCount,
  type SampleBatch,
  selectBatches,
  staticFields,
} from '@latkit/model'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { Case, catalog } from '../gridkit/index.js'
import type { SamplesInput } from '../shared/messages.js'
import { chunkFrames, type Layout, readResults } from './decode.js'
import { PROGRESS_MS } from './limits.js'
import { described, ResultCache, ResultsFile } from './results.js'

const HEADER = 'time,Bus_A_Vm\n'
const signal = new AbortController().signal
let kase: Case
let directory: string
/** A finished file of a few chunks, with a blank row partway and no newline after its last. */
const large = { path: '', rows: 700_000 }

beforeAll(async () => {
  kase = await Case.parse('{"buses":[{"class":"Bus","number":1,"name":"A"}]}', catalog)
  directory = await mkdtemp(join(tmpdir(), 'gridkit-results-test-'))
  large.path = join(directory, 'large.csv')
  const rows = Array.from({ length: large.rows }, (_, i) => `${i / 1000},${1 + (i % 1000) / 1e4}`)
  rows[1000] = '\n' + rows[1000]
  await writeFile(large.path, HEADER + rows.join('\n'))
})
afterAll(() => rm(directory, { recursive: true, force: true }))

/** A reading of the CSV results at `path` for `of`. */
function file(path: string, cache = new ResultCache(), of = kase): ResultsFile {
  return new ResultsFile(described(of, { uri: 'file:///case', version: 1 }, path), of, cache)
}

/** Reads `results` while its file grows, until `end` says the writer is done. */
function following(results: ResultsFile, progress = () => {}) {
  let ended = false
  const reading = results.ingest(signal, () => ended, progress)
  return {
    /** Waits until the reader holds `frames` frames. */
    reach: (frames: number) =>
      vi.waitFor(() => expect(results.info.frames).toBe(frames), { timeout: 5000 }),
    end: () => {
      ended = true
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
    results: results.info.id,
    field: { from: 'Bus', select: ['Vm'] },
    window,
    held,
    bytes,
  }
  return results.samples(input, signal)
}

/** Each batch's frames, as `[first frame, count]`, and the values of the first row. */
const framesOf = (batches: readonly SampleBatch[]) =>
  batches.map((batch) => [batch.firstFrame, batch.coordinates.length])
function valuesOf(batches: readonly SampleBatch[]) {
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
        'csv',
        layout,
      )
      return values
    }
    expect(await segment('time,Bus_A_Vm\n0,1.5\n')).toEqual([1.5])
    const read = layout.read
    // A later segment is rows alone: the header is not read, or matched name by name, again.
    expect(await segment('0.01,1.25\n')).toEqual([1.25])
    expect(layout.read).toBe(read)
  })

  it('learns what a file holds from its header, whatever order GridKit wrote it in', async () => {
    const two = await Case.parse(
      '{"buses":[{"class":"Bus","number":1,"name":"A"},{"class":"Bus","number":2,"name":"B"}]}',
      catalog,
    )
    const path = join(directory, 'header.csv')
    await writeFile(path, 'time,Bus_B_Vm,Bus_A_Va,"Other_x_y",bus_a_vm\n0,1.2,0.5,9,1.1\n')
    const results = file(path, new ResultCache(), two)
    await results.ingest(
      signal,
      () => true,
      () => {},
    )
    // Each output in catalog and row order, matched by name whatever its case, and a column the
    // case has no output for left unread.
    expect(results.info.outputs).toEqual([
      { from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1', 'Bus/2'] } },
      { from: 'Bus', select: ['Va'], rows: { kind: 'ids', ids: ['Bus/1'] } },
    ])
    expect(results.info.domains).toEqual({ Bus: { Vm: [1.1, 1.2], Va: [0.5, 0.5] } })
    const unknown = join(directory, 'unknown.csv')
    await writeFile(unknown, 'time,Other_x_y\n0,1\n')
    await expect(
      file(unknown, new ResultCache(), two).ingest(
        signal,
        () => true,
        () => {},
      ),
    ).rejects.toThrow('No result columns match this case')
  })

  it('sends the rows a view names, of those the file holds', async () => {
    const three = await Case.parse(
      JSON.stringify({
        buses: ['A', 'B', 'C'].map((name, i) => ({ class: 'Bus', number: i + 1, name })),
      }),
      catalog,
    )
    const path = join(directory, 'rows.csv')
    await writeFile(path, 'time,Bus_A_Vm,Bus_C_Vm\n0,1.1,1.3\n0.01,1.2,1.4\n')
    const results = file(path, new ResultCache(), three)
    await results.ingest(
      signal,
      () => true,
      () => {},
    )
    const named = async (ids?: string[]) =>
      results.samples(
        {
          results: results.info.id,
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
    // Bus B is not in the file: of the rows named, only Bus C comes.
    const [some] = await named(['Bus/2', 'Bus/3'])
    expect(some!.rows).toEqual({ kind: 'range', offset: 2, count: 1 })
    expect(Array.from(some!.columns.Vm!.values)).toEqual([1.3, 1.4])
    expect(await named(['Bus/2'])).toEqual([])
  })

  it('cuts a file into chunks of a size its header sets, which a view asks for whole', async () => {
    const results = file(large.path)
    await results.ingest(
      signal,
      () => true,
      () => {},
    )
    const { chunk, frames } = results.info
    expect(frames).toBe(large.rows)
    expect(chunk).toBeGreaterThan(1)
    expect(frames).toBeGreaterThan(2 * chunk)
    expect(results.info.domains).toEqual({ Bus: { Vm: [1, 1.0999] } })
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

  it('keeps the frames it read: what a view asks for needs no second read of the file', async () => {
    const path = join(directory, 'kept.csv')
    await writeFile(path, HEADER + '0,1\n0.01,1.5\n0.02,1.25\n')
    const results = file(path)
    await results.ingest(
      signal,
      () => true,
      () => {},
    )
    await rm(path)
    expect(valuesOf(await asked(results, [0, 0.02]))).toEqual([1, 1.5, 1.25])
  })

  it('sends a growing chunk only the frames the view lacks of it', async () => {
    const path = join(directory, 'growing.csv')
    await writeFile(path, HEADER + '0,1\n0.01,1.1\n0.02,1.2\n')
    const results = file(path)
    const reader = following(results)
    await reader.reach(3)
    expect(valuesOf(await asked(results, [0, 0.02]))).toEqual([1, 1.1, 1.2])
    // A row the writer is partway through waits for its end.
    await appendFile(path, '0.03,1.3\n0.04,1.')
    await reader.reach(4)
    await appendFile(path, '4\n')
    await reader.end()
    expect(results.info.frames).toBe(5)
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
    const results = file(path)
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
    const results = file(path)
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

  it('reads a chunk its cache let go of again from the file, exactly', async () => {
    const cache = new ResultCache(1 << 20)
    const results = file(large.path, cache)
    await results.ingest(
      signal,
      () => true,
      () => {},
    )
    // Too large for the cache, the whole chunks are decoded again when a view asks.
    expect(cache.bytes).toBeLessThanOrEqual(1 << 20)
    const { chunk } = results.info
    const values = valuesOf(await asked(results, [chunk / 1000, chunk / 1000]))
    expect(values).toHaveLength(chunk)
    expect(values.slice(0, 3)).toEqual([0, 1, 2].map((i) => 1 + ((chunk + i) % 1000) / 1e4))
    // Reading an early window again never shrinks the whole file's ranges.
    expect(results.info.domains).toEqual({ Bus: { Vm: [1, 1.0999] } })
  })

  it('sends about as many bytes as asked, a chunk at least, nearest first', async () => {
    const results = file(large.path)
    await results.ingest(
      signal,
      () => true,
      () => {},
    )
    const { chunk, frames } = results.info
    const end = (frames - 1) / 1000
    const one = await asked(results, [0, end], {}, 1)
    expect(framesOf(one)).toEqual([[0, chunk]])
    const near = await results.samples(
      {
        results: results.info.id,
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
