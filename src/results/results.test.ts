import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'

import {
  blockBuffers,
  type Publication,
  read,
  type SampleBatch,
  selectBatches,
  staticFields,
} from '@latkit/model'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { Case, catalog } from '../gridkit/index.js'
import type { SimulationInfo } from '../shared/messages.js'
import { type Layout, readResults } from './decode.js'
import { PAGE_BYTES, PROGRESS_MS } from './limits.js'
import { ResultCache, Results } from './results.js'

const HEADER = 'time,Bus_A_Vm\n'
const signal = new AbortController().signal
let kase: Case
let directory: string
/** A finished file of a few pages, with a blank row partway and no newline after its last. */
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
function results(path: string, cache = new ResultCache(), of = kase): Results {
  const info: SimulationInfo = {
    id: crypto.randomUUID(),
    revision: { uri: 'file:///case', version: 1 },
    fingerprint: of.version,
    name: 'test',
    state: 'complete',
    path,
    format: 'csv',
    frames: 0,
    domain: [0, 0],
    started: 0,
    outputs: [],
  }
  return new Results(info, of, cache)
}

/** Ingests `run` while its file grows, until `end` says the writer is done. */
function following(run: Results) {
  let ended = false
  const ingesting = run.ingest(
    signal,
    () => ended,
    async () => {},
  )
  return {
    /** Waits until the reader holds `frames` frames. */
    reach: (frames: number) =>
      vi.waitFor(() => expect(run.info.frames).toBe(frames), { timeout: 5000 }),
    end: () => {
      ended = true
      return ingesting
    },
  }
}

/** Each page's columns of `run`'s Vm. */
async function columns(run: Results) {
  const pages = []
  for (let p = 0; p < run.pages.length; p++)
    pages.push(
      [...(await run.pageData(p, signal)).tables.Bus!.fields.Vm!].map((page) => page.column),
    )
  return pages
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

  it('reads every page of a run with the layout its header gave the first', async () => {
    const layout: Layout = {}
    const page = async (text: string) => {
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
    expect(await page('time,Bus_A_Vm\n0,1.5\n')).toEqual([1.5])
    const read = layout.read
    // A later page is rows alone: the header is not read, or matched name by name, again.
    expect(await page('0.01,1.25\n')).toEqual([1.25])
    expect(layout.read).toBe(read)
  })

  it('learns what a file holds from its header, whatever order GridKit wrote it in', async () => {
    const two = await Case.parse(
      '{"buses":[{"class":"Bus","number":1,"name":"A"},{"class":"Bus","number":2,"name":"B"}]}',
      catalog,
    )
    const path = join(directory, 'header.csv')
    await writeFile(path, 'time,Bus_B_Vm,Bus_A_Va,"Other_x_y",bus_a_vm\n0,1.2,0.5,9,1.1\n')
    const run = results(path, new ResultCache(), two)
    await run.ingest(
      signal,
      () => true,
      async () => {},
    )
    // Each output in catalog and row order, matched by name whatever its case, and a column the
    // case has no output for left unread.
    expect(run.info.outputs).toEqual([
      { from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1', 'Bus/2'] } },
      { from: 'Bus', select: ['Va'], rows: { kind: 'ids', ids: ['Bus/1'] } },
    ])
    expect(run.info.domains).toEqual({ Bus: { Vm: [1.1, 1.2], Va: [0.5, 0.5] } })
    const unknown = join(directory, 'unknown.csv')
    await writeFile(unknown, 'time,Other_x_y\n0,1\n')
    await expect(
      results(unknown, new ResultCache(), two).ingest(
        signal,
        () => true,
        async () => {},
      ),
    ).rejects.toThrow('No result columns match this case')
  })

  it('keeps the batches it publishes: a page is decoded once', async () => {
    const path = join(directory, 'once.csv')
    await writeFile(path, HEADER + '0,1\n0.01,1.5\n')
    const run = results(path)
    const published: Publication[] = []
    await run.ingest(
      signal,
      () => true,
      async (batches) => {
        published.push(batches)
      },
    )
    expect(published).toHaveLength(1)
    const batch = published[0]![0] as SampleBatch
    // The page read back is the very arrays published, with no copy between.
    const [page] = (await columns(run))[0]!
    expect(page).toBe(batch.columns.Vm)
    expect(Array.from(batch.columns.Vm!.values)).toEqual([1, 1.5])
  })

  it('pages a finished file at the first row end past the page size', async () => {
    const run = results(large.path)
    await run.ingest(
      signal,
      () => true,
      async () => {},
    )
    expect(run.info.frames).toBe(large.rows)
    expect(run.info.domains).toEqual({ Bus: { Vm: [1, 1.0999] } })
    expect(run.pages.length).toBeGreaterThan(1)
    expect(run.pages[0]!.start).toBe(HEADER.length)
    expect(run.pages.at(-1)!.end).toBe((await stat(large.path)).size)
    for (const [p, page] of run.pages.slice(0, -1).entries()) {
      const next = run.pages[p + 1]!
      expect(next.start).toBe(page.end)
      expect(next.first).toBe(page.first + page.count)
      // Past the page size by less than a row.
      expect(page.end - page.start).toBeGreaterThanOrEqual(PAGE_BYTES)
      expect(page.end - page.start).toBeLessThan(PAGE_BYTES + 32)
    }
  })

  it('pages a growing file as the views would take its rows, far short of the page size', async () => {
    const path = join(directory, 'growing.csv')
    await writeFile(path, HEADER + '0,1\n0.01,1.1\n0.02,1.2\n')
    const run = results(path)
    const reader = following(run)
    // The first rows are a page as soon as the reader has them.
    await reader.reach(3)
    expect(run.pages.length).toBeGreaterThan(0)
    // A row the writer is partway through waits for its end.
    await appendFile(path, '0.03,1.3\n0.04,1.')
    await reader.reach(4)
    await appendFile(path, '4\n')
    await reader.end()
    expect(run.info.frames).toBe(5)
    expect(run.pages.length).toBeGreaterThan(1)
    const data = await run.data(undefined, signal)
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

  it('pages a run that writes on and on no oftener than the views take its rows', async () => {
    const path = join(directory, 'busy.csv')
    await writeFile(path, HEADER)
    const run = results(path)
    const reader = following(run)
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
    // The first page at once, then one each time the views look, however often GridKit writes.
    expect(run.pages.length).toBeGreaterThan(1)
    expect(run.pages.length).toBeLessThanOrEqual(Math.ceil(elapsed / PROGRESS_MS) + 1)
  })

  it('steps between frames from its pages alone, with the file gone', async () => {
    const path = join(directory, 'steps.csv')
    await writeFile(path, HEADER)
    const run = results(path)
    const reader = following(run)
    // A fault's boundaries repeat their times, here across pages.
    let frames = 0
    for (const rows of ['0,1\n0.01,1\n0.02,1\n', '0.02,0.5\n0.03,0.5\n', '0.03,1\n0.04,1\n']) {
      await appendFile(path, rows)
      await reader.reach((frames += rows.split('\n').length - 1))
    }
    await reader.end()
    expect(run.pages.length).toBeGreaterThanOrEqual(3)
    await rm(path)
    const times = [0, 0.01, 0.02, 0.02, 0.03, 0.03, 0.04]
    for (const at of [-1, ...times, 0.005, 0.025, 0.035, 1]) {
      expect(run.step(at, 1)).toBe(times.find((time) => time > at) ?? 0.04)
      expect(run.step(at, -1)).toBe(times.findLast((time) => time < at) ?? 0)
    }
  })

  it('evicts within budget and reloads exact native-file windows', async () => {
    const path = join(directory, 'evicted.csv')
    await writeFile(path, HEADER)
    const cache = new ResultCache(1500)
    const run = results(path, cache)
    const reader = following(run)
    // A few pages, which together outgrow the cache.
    for (let page = 0; page < 4; page++) {
      await appendFile(
        path,
        Array.from(
          { length: 50 },
          (_, i) => `${(50 * page + i) / 100},${1 + (50 * page + i) / 1000}\n`,
        ).join(''),
      )
      await reader.reach(50 * (page + 1))
    }
    await reader.end()
    expect(run.info.domains).toEqual({ Bus: { Vm: [1, 1.199] } })
    expect(cache.bytes).toBeLessThanOrEqual(1500)
    const data = await run.data([0, 0.1], signal)
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
    // Eviction and reloading an early window never shrink whole-run normalization.
    expect(run.info.domains).toEqual({ Bus: { Vm: [1, 1.199] } })
  })
})
