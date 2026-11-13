import { expect, it } from 'vitest'

import { detail, Pyramid, type ReducedRun } from './pyramid.js'

it('reduces exact eight-way boundaries with irregular times, gaps, and restart tails', () => {
  const expected: ReducedRun[] = []
  const actual: ReducedRun[] = []
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
  expect(actual.find((run) => run.level === 2)?.values).toEqual(Float32Array.of(0, 1000))
  // A frame with no value is a gap of its bucket, and of each bucket over it, and of no other.
  const gapped = (level: number, first: number) =>
    actual.find((run) => run.level === level && run.first === first)?.gaps[0]
  expect([gapped(1, 1), gapped(1, 2), gapped(1, 3), gapped(2, 0)]).toEqual([0, 1, 0, 1])
})

it('holds a plot in buckets no wider than a pixel column', () => {
  for (const columns of [1, 37, 440, 2400])
    for (const frames of [1, 2, 2403, 600_000, 9e15]) {
      const level = detail(frames, columns)
      // Each bucket spans at most a column; the next level's would span more.
      if (level > 0) expect(frames / 8 ** level).toBeGreaterThanOrEqual(columns)
      expect(frames / 8 ** (level + 1)).toBeLessThan(columns)
    }
})
