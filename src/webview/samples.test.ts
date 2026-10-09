import {
  blockByteLength,
  createData,
  type Domain,
  read,
  type SampleBatch,
  textColumn,
} from '@latkit/model'
import { describe, expect, it, vi } from 'vitest'

import type { Results, SamplesInput } from '../shared/messages.js'
import { Samples } from './samples.js'

const index = { source: 'case', type: 'Bus', version: '1' }
const rows = createData(
  {
    axis: { name: 'time' },
    types: {
      Bus: {
        fields: { Vm: { type: 'float64', sampled: true }, Va: { type: 'float64', sampled: true } },
      },
    },
  },
  [
    {
      kind: 'rows',
      index,
      rows: { kind: 'range', offset: 0, count: 2 },
      ids: textColumn(['Bus/1', 'Bus/2']),
      columns: {},
    },
  ],
)
const need = { selection: { from: 'Bus', select: ['Vm'] }, rows: 2 }
const angle = { selection: { from: 'Bus', select: ['Va'] }, rows: 2 }
/** Frames per chunk, and the time between frames. */
const CHUNK = 4
const STEP = 0.01

/** Results of `frames` frames, one every STEP. */
const results = (frames: number, id = 'results'): Results => ({
  id,
  revision: { uri: 'file:///case', version: 1 },
  fingerprint: '1',
  name: 'results.csv',
  path: 'results.csv',
  format: 'csv',
  outputs: [{ from: 'Bus', select: ['Vm', 'Va'] }],
  frames,
  domain: [0, (frames - 1) * STEP],
  chunk: CHUNK,
  growing: false,
  started: 0,
})

/** A worker that answers as the real one does, from results of `frames` frames, keeping what it
 *  was asked. Frame `f`'s value for row `r` is `f + r / 10`. */
function worker(file: { frames: number }) {
  const asked: SamplesInput[] = []
  const request = vi.fn(async (input: SamplesInput) => {
    asked.push(input)
    const time = (frame: number) => frame * STEP
    const [a, b] = input.window
    let first = 0
    while (first + 1 < file.frames && time(first + 1) <= a) first++
    let last = first
    while (last + 1 < file.frames && time(last) < b) last++
    const chunks: number[] = []
    for (let k = Math.floor(first / CHUNK); k * CHUNK <= last; k++) chunks.push(k)
    const near = input.near
    if (near)
      chunks.sort(
        (x, y) =>
          Math.abs(time(x * CHUNK) - near.at) - Math.abs(time(y * CHUNK) - near.at) || x - y,
      )
    const reply: SampleBatch[] = []
    let size = 0
    for (const k of chunks) {
      const from = k * CHUNK + (input.held[k] ?? 0)
      const to = Math.min(file.frames, (k + 1) * CHUNK)
      if (from >= to) continue
      if (reply.length && size >= input.bytes) break
      const count = to - from
      const values = Float64Array.from(
        { length: 2 * count },
        (_, i) => from + (i >> 1) + (i % 2) / 10,
      )
      const batch: SampleBatch = {
        kind: 'samples',
        index,
        rows: { kind: 'range', offset: 0, count: 2 },
        firstFrame: from,
        coordinates: Float64Array.from({ length: count }, (_, i) => time(from + i)),
        columns: {
          [input.field.select[0]!]: {
            kind: 'numeric',
            values,
            offset: 0,
            length: values.length,
            frameStride: 2,
            rowStride: 1,
          },
        },
      }
      reply.push(batch)
      size += blockByteLength([batch])
    }
    return reply
  })
  return { asked, request }
}

/** A cache of samples, asking `request`, holding `budget` bytes. */
function cache(request: ReturnType<typeof worker>['request'], budget?: number) {
  const changed = vi.fn()
  const report = vi.fn()
  const samples = new Samples({ request, changed, report, ...(budget && { budget }) })
  return { samples, changed, report }
}

/** Bus 1's voltage at each frame `samples` hold over `window`. */
async function voltages(samples: Samples, window: Domain) {
  const values: number[] = []
  for await (const block of read(samples.data(rows), {
    kind: 'samples',
    from: 'Bus',
    select: ['Vm'],
    rows: { kind: 'ids', ids: ['Bus/1'] },
    window: { kind: 'range', between: window },
  })) {
    const column = block.columns.Vm!
    for (let t = 0; t < block.coordinates.length; t++)
      values.push(column.values[column.offset + t * column.frameStride]!)
  }
  return values
}

describe('the samples a view holds', () => {
  it('asks only for what it lacks over the time it shows, and draws from that', async () => {
    const file = { frames: 12 }
    const { asked, request } = worker(file)
    const { samples } = cache(request)
    const shown = results(file.frames)
    // A moment in the second chunk needs the second chunk.
    samples.want(shown, [need], [0.05, 0.05])
    await vi.waitFor(() => expect(samples.covers('Bus', 'Vm', [0.05, 0.05])).toBe(true))
    expect(asked[0]).toMatchObject({ window: [0.05, 0.05], held: {} })
    expect(samples.covers('Bus', 'Vm', [0.08, 0.08])).toBe(false)
    expect(await voltages(samples, [0.04, 0.07])).toEqual([4, 5, 6, 7])
    // Asking again for what it holds asks nothing.
    samples.want(shown, [need], [0.06, 0.06])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(asked).toHaveLength(1)
  })

  it('takes a growing chunk as the frames past those it holds, appending them', async () => {
    const file = { frames: 6 }
    const { asked, request } = worker(file)
    const { samples } = cache(request)
    samples.want(results(6), [need], [0, 0.05])
    await vi.waitFor(() => expect(samples.covers('Bus', 'Vm', [0, 0.05])).toBe(true))
    const before = samples.data(rows)
    file.frames = 8
    samples.want(results(8), [need], [0, 0.07])
    await vi.waitFor(() => expect(samples.covers('Bus', 'Vm', [0, 0.07])).toBe(true))
    expect(asked.at(-1)!.held).toEqual({ 0: 4, 1: 2 })
    // What was drawn stays: the new frames are appended to it.
    const after = samples.data(rows)
    expect(after).not.toBe(before)
    expect(samples.data(rows)).toBe(after)
    expect(await voltages(samples, [0, 0.07])).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('loads around the playhead as far as its budget, and lets the farthest go past it', async () => {
    const file = { frames: 40 }
    const { request } = worker(file)
    const shown = results(file.frames)
    // A chunk's bytes, as the view counts them.
    const one = await request({
      results: shown.id,
      field: need.selection,
      window: [0, 0],
      held: {},
      bytes: Infinity,
    })
    const budget = 3 * blockByteLength(one)
    const { samples } = cache(request, budget)
    samples.want(shown, [need], [0.2, 0.2], { at: 0.2, travel: 0 })
    await vi.waitFor(() => expect(samples.stats().held).toBe(3))
    expect(samples.stats().bytes).toBeLessThanOrEqual(budget)
    // Those held are the nearest: the chunk of the moment and one either side.
    expect(samples.covers('Bus', 'Vm', [0.16, 0.27])).toBe(true)
    // A seek far off takes its chunk, and lets the farthest from it go.
    samples.want(shown, [need], [0.37, 0.37], { at: 0.37, travel: 0 })
    await vi.waitFor(() => expect(samples.covers('Bus', 'Vm', [0.37, 0.37])).toBe(true))
    expect(samples.stats().bytes).toBeLessThanOrEqual(budget)
    expect(samples.covers('Bus', 'Vm', [0.16, 0.16])).toBe(false)
  })

  it('loads around the playhead evenly for the fields it draws together', async () => {
    const file = { frames: 40 }
    const { request } = worker(file)
    const shown = results(file.frames)
    const one = await request({
      results: shown.id,
      field: need.selection,
      window: [0, 0],
      held: {},
      bytes: Infinity,
    })
    const { samples } = cache(request, 6 * blockByteLength(one))
    samples.want(shown, [need, angle], [0.2, 0.2], { at: 0.2, travel: 0 })
    await vi.waitFor(() => expect(samples.stats().held).toBe(6))
    // Each field holds the same times: the moment's chunk and one either side.
    for (const field of ['Vm', 'Va'])
      expect(samples.covers('Bus', field, [0.16, 0.27]), field).toBe(true)
  })

  it('says it cannot have what it needs when an ask brings nothing, and asks again for more', async () => {
    const { request } = worker({ frames: 0 })
    const { samples, changed } = cache(request)
    samples.want(results(8), [need], [0.03, 0.03])
    await vi.waitFor(() => expect(samples.stuck).toBe(true))
    expect(changed).toHaveBeenCalled()
    // More frames read is something more to ask for.
    samples.want(results(9), [need], [0.03, 0.03])
    expect(samples.stuck).toBe(false)
  })

  it('reports a failed ask once, and nothing of results let go of', async () => {
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('Unreadable'), { code: 'io' })
    })
    const { samples, report } = cache(failing)
    samples.want(results(8), [need], [0, 0])
    await vi.waitFor(() => expect(samples.stuck).toBe(true))
    samples.want(results(8), [need], [0, 0])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(report).toHaveBeenCalledOnce()
    const gone = vi.fn(async () => {
      throw Object.assign(new Error('Gone'), { code: 'results-unavailable' })
    })
    const quiet = cache(gone)
    quiet.samples.want(results(8), [need], [0, 0])
    await vi.waitFor(() => expect(quiet.samples.stuck).toBe(true))
    expect(quiet.report).not.toHaveBeenCalled()
  })

  it('lets go of everything held when the view shows other results', async () => {
    const file = { frames: 8 }
    const { request } = worker(file)
    const { samples } = cache(request)
    samples.want(results(8, 'first'), [need], [0, 0.07])
    await vi.waitFor(() => expect(samples.covers('Bus', 'Vm', [0, 0.07])).toBe(true))
    samples.want(results(8, 'second'), [need], undefined)
    expect(samples.results).toBe('second')
    expect(samples.stats()).toEqual({ held: 0, bytes: 0 })
    expect(samples.sampled()).toEqual([])
  })
})
