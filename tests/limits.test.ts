import type { Series } from '@latkit/model'
import { expect, it, vi } from 'vitest'

import { ByteBudget } from '../src/budget.js'
import { MAX_READ_BYTES, sampleBytes } from '../src/csv/limits.js'
import { isCsvQuery } from '../src/csv/protocol.js'
import { leasedSampleTiles, sampleTiles } from '../src/csv/tiles.js'
function series(frames: number, elements: number): Series {
  return {
    elementCount: elements,
    signalCount: 1,
    state: { frameCount: frames, timeRange: null, ranges: null },
    on: () => () => {},
    locate: async () => [0, frames],
    read: vi.fn(async (_signal, window) => ({
      time: Float64Array.from({ length: window.frameCount }, (_, f) => window.frameOffset + f),
      values: Float64Array.from(
        { length: window.frameCount * window.elementCount },
        (_, i) =>
          (window.frameOffset + Math.floor(i / window.elementCount)) * 100 +
          window.elementOffset +
          (i % window.elementCount),
      ),
      stride: window.elementCount,
    })),
  }
}
it('rejects overflow and oversized allocations before any buffers are created', () => {
  expect(sampleBytes(MAX_READ_BYTES / 16, 1)).toBe(MAX_READ_BYTES)
  for (const [frames, elements] of [
    [Number.MAX_SAFE_INTEGER, 1],
    [1, Number.MAX_SAFE_INTEGER],
    [-1, 2],
    [1.5, 2],
    [Infinity, 0],
  ])
    expect(() => sampleBytes(frames, elements)).toThrow(RangeError)
  expect(
    isCsvQuery({ type: 'read', frameOffset: 0, frameCount: Number.MAX_SAFE_INTEGER, columns: [1] }),
  ).toBe(false)
  expect(isCsvQuery({ type: 'bounds', range: [1, 0], frameCount: 2 })).toBe(false)
  expect(isCsvQuery({ type: 'read', frameOffset: 0, frameCount: 2, columns: [1, -1] })).toBe(true)
})
it('tiles both axes exactly, including partial windows and time-only reads', async () => {
  for (const budget of [16, 32, 128, 1024])
    for (const elements of [0, 1, 7, 21]) {
      const source = series(23, elements + 3)
      const samples = new Map<string, number>()
      const times = new Set<number>()
      for await (const block of sampleTiles(
        source,
        0,
        { frameOffset: 3, frameCount: 17, elementOffset: 2, elementCount: elements },
        undefined,
        budget,
      )) {
        expect(block.time.byteLength + block.values.byteLength).toBeLessThanOrEqual(budget)
        for (let f = 0; f < block.time.length; f++) {
          times.add(block.time[f])
          for (let e = 0; e < block.stride; e++) {
            const element = block.window.elementOffset + e
            const key = block.time[f] + ':' + element
            expect(samples.has(key)).toBe(false)
            samples.set(key, block.values[f * block.stride + e])
            expect(samples.get(key)).toBe(block.time[f] * 100 + element)
          }
        }
      }
      expect(samples.size).toBe(17 * elements)
      expect([...times].sort((a, b) => a - b)).toEqual(Array.from({ length: 17 }, (_, i) => i + 3))
    }
})
it('captures the requested head and aborts before requesting another tile', async () => {
  const source = series(10, 3)
  const controller = new AbortController()
  const tiles = sampleTiles(
    source,
    0,
    { frameOffset: 0, frameCount: 10, elementOffset: 0, elementCount: 3 },
    controller.signal,
    32,
  )
  await tiles.next()
  controller.abort()
  await expect(tiles.next()).rejects.toMatchObject({ name: 'AbortError' })
  expect(source.read).toHaveBeenCalledTimes(1)
  await expect(
    sampleTiles(source, 0, {
      frameOffset: 0,
      frameCount: 11,
      elementOffset: 0,
      elementCount: 3,
    }).next(),
  ).rejects.toThrow(RangeError)
})
it('holds shared budget until release and removes cancelled waiters', async () => {
  const budget = new ByteBudget(32)
  const first = await budget.acquire(32)
  const controller = new AbortController()
  const cancelled = budget.acquire(16, controller.signal)
  const reject = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await reject
  let admitted = false
  const waiting = budget.acquire(32).then((release) => {
    admitted = true
    return release
  })
  await Promise.resolve()
  expect(admitted).toBe(false)
  first()
  first()
  const second = await waiting
  second()
  await expect(budget.acquire(33)).rejects.toThrow(RangeError)
  const block = await leasedSampleTiles(series(1, 1), 0, {
    frameOffset: 0,
    frameCount: 1,
    elementOffset: 0,
    elementCount: 1,
  }).next()
  if (!block.done) {
    block.value.release()
    block.value.release()
  }
})
