import { expect, it } from 'vitest'

import type { VisualizationRun } from './frames.js'
import { Pyramid } from './pyramid.js'

it('reduces exact eight-way boundaries with irregular times, gaps, and restart tails', () => {
  const expected: VisualizationRun[] = []
  const actual: VisualizationRun[] = []
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
  // A frame without a value is left out of its buckets, as latkit's own levels leave it.
  expect(actual.find((run) => run.level === 1 && run.first === 2)?.values).toEqual(
    Float32Array.of(16, 1000),
  )
  expect(actual.find((run) => run.level === 2)?.values).toEqual(Float32Array.of(0, 1000))
})

it("ends each level with the bucket still filling, over every frame since the level's last", () => {
  // 75 frames: 9 full buckets of 8 and one of 3 filling at level 1, 1 full and one of 11 at 2.
  const pyramid = new Pyramid(2, () => {})
  const at = Float64Array.from({ length: 75 }, (_, i) => i / 10)
  pyramid.push(
    0,
    at,
    Float64Array.from({ length: 150 }, (_, i) => (i % 2 ? -i : i)),
  )
  expect(pyramid.tail(1)).toEqual({
    level: 1,
    first: 9,
    at: Float64Array.of(7.2, 7.4),
    values: Float32Array.of(144, -149, 148, -145),
  })
  // Level 2's filling bucket holds level 1's full bucket of frames 64 to 71, and its filling one.
  expect(pyramid.tail(2)).toEqual({
    level: 2,
    first: 1,
    at: Float64Array.of(6.4, 7.4),
    values: Float32Array.of(128, -149, 148, -129),
  })
  // All 75 lie in the bucket of 512 filling at level 3.
  expect(pyramid.tail(3)?.first).toBe(0)
  expect(pyramid.tail(3)?.at).toEqual(Float64Array.of(0, 7.4))
  const even = new Pyramid(1, () => {})
  even.push(
    0,
    Float64Array.from({ length: 8 }, (_, i) => i),
    new Float64Array(8),
  )
  expect(even.tail(1)).toBeUndefined()
})
