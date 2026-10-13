import type { Data } from '@latkit/model'
import { describe, expect, it, vi } from 'vitest'

import { type Frames, ResultCache } from './cache.js'

/** One batch of `count` frames of one row's value: 8 bytes a frame of its own, the times being the
 *  file's. */
const frames = (count: number): Frames => [
  {
    kind: 'samples',
    index: { source: 'case', type: 'Bus', version: 'case' },
    rows: { kind: 'range', offset: 0, count: 1 },
    firstFrame: 0,
    coordinates: new Float64Array(count),
    columns: {
      Vm: {
        kind: 'numeric',
        values: new Float64Array(count),
        offset: 0,
        length: count,
        frameStride: 1,
        rowStride: 1,
      },
    },
  } as Data.SampleBatch,
]

describe('what a worker keeps of the results files it reads', () => {
  it('keeps what one file puts again by the same key once, and lets go of it with the file', () => {
    const cache = new ResultCache(1 << 20)
    const file = {}
    cache.put(file, 0, frames(4), false)
    cache.put(file, 0, frames(8), true)
    expect(cache.bytes).toBe(8 * 8)
    expect(cache.get(file, 0)?.[0]?.coordinates.length).toBe(8)
    cache.drop(file)
    expect(cache.bytes).toBe(0)
    expect(cache.get(file, 0)).toBeUndefined()
  })

  it('lets go of the least recently used past its limit, of any file', () => {
    const cache = new ResultCache(2 * 4 * 8)
    const [one, two] = [{}, {}]
    cache.put(one, 0, frames(4), true)
    cache.put(two, 0, frames(4), true)
    // Read again, the first is the most recently used, so the second goes.
    cache.get(one, 0)
    cache.put(two, 1, frames(4), true)
    expect(cache.get(two, 0)).toBeUndefined()
    expect(cache.get(one, 0)).toBeDefined()
    expect(cache.bytes).toBe(2 * 4 * 8)
    // A chunk past the limit alone is never kept.
    cache.put(one, 1, frames(100), true)
    expect(cache.get(one, 1)).toBeUndefined()
  })

  it('lets a file read through pass through what is cold, keeping what views read', () => {
    const cache = new ResultCache(4 * 4 * 8)
    const [viewed, read] = [{}, {}]
    for (let k = 0; k < 3; k++) cache.put(viewed, k, frames(4), true)
    // A file read through after, chunk by chunk, many more than the cache holds.
    for (let k = 0; k < 100; k++) cache.put(read, k, frames(4), false)
    for (let k = 0; k < 3; k++) expect(cache.get(viewed, k)).toBeDefined()
    // A cold chunk a view reads is warm from then on.
    expect(cache.get(read, 99)).toBeDefined()
    cache.put(read, 100, frames(4), false)
    expect(cache.get(read, 99)).toBeDefined()
  })

  it('keeps a file nothing holds under the same budget, until it is opened again or past it', () => {
    const cache = new ResultCache(4 * 4 * 8)
    const [resting, woken, other] = [{}, {}, {}]
    const evicted = vi.fn()
    cache.rest(resting, 2 * 4 * 8, evicted)
    cache.rest(woken, 4 * 8, () => {
      throw new Error('a file opened again is never let go of')
    })
    cache.wake(woken)
    expect(cache.bytes).toBe(2 * 4 * 8)
    // Chunks views read push the resting file out.
    for (let k = 0; k < 3; k++) cache.put(other, k, frames(4), true)
    expect(evicted).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(3 * 4 * 8)
    // A file larger than the whole budget is let go of at once.
    const large = vi.fn()
    cache.rest({}, 1 << 20, large)
    expect(large).toHaveBeenCalledOnce()
  })
})
