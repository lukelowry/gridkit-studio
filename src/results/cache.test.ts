import type { Data } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import { type Frames, ResultCache } from './cache.js'

/** One batch of `count` frames of one row's value: 16 bytes a frame, its time and its value. */
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

describe('decoded chunks kept for the files that read them', () => {
  it('keeps what one file puts again by the same key once, and lets go of it with the file', () => {
    const cache = new ResultCache(1 << 20)
    const file = {}
    cache.put(file, 0, frames(4))
    cache.put(file, 0, frames(8))
    expect(cache.bytes).toBe(8 * 16)
    expect(cache.get(file, 0)?.[0]?.coordinates.length).toBe(8)
    cache.drop(file)
    expect(cache.bytes).toBe(0)
    expect(cache.get(file, 0)).toBeUndefined()
  })

  it('lets go of the least recently used past its limit, of any file', () => {
    const cache = new ResultCache(2 * 4 * 16)
    const [one, two] = [{}, {}]
    cache.put(one, 0, frames(4))
    cache.put(two, 0, frames(4))
    // Read again, the first is the most recently used, so the second goes.
    cache.get(one, 0)
    cache.put(two, 1, frames(4))
    expect(cache.get(two, 0)).toBeUndefined()
    expect(cache.get(one, 0)).toBeDefined()
    expect(cache.bytes).toBe(2 * 4 * 16)
    // A chunk past the limit alone is never kept.
    cache.put(one, 1, frames(100))
    expect(cache.get(one, 1)).toBeUndefined()
  })
})
