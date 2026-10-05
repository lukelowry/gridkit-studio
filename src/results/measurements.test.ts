import { describe, expect, it } from 'vitest'

import type { ElementStats, Metric } from '../shared/analysis.js'
import { Measurements, validateMetrics } from './measurements.js'

const threshold: Metric = {
  kind: 'threshold',
  lower: 0.9,
  durationMethod: 'left-hold',
  maxGapSeconds: 1,
}
const result = (): ElementStats => ({ id: 'Bus/1', valid: 0, missing: 0, min: null, max: null })

describe('sample measurements', () => {
  it('preserves episodes across pages, retains repeated frames and excludes missing/large gaps from duration', () => {
    const row = result()
    const measure = new Measurements(row, [threshold, { kind: 'initial-final' }])
    const samples: [number, number | null][] = [
      [0, 1],
      [1, 0.8],
      [1, 0.7],
      [2, 0.8],
      [3, 1],
      [4, null],
      [5, 0.8],
      [8, 0.8],
      [9, 1],
    ]
    samples.forEach(([time, value], frame) => measure.add(time, frame, value))
    expect(row.threshold).toEqual({
      samples: 5,
      episodes: 3,
      estimatedSeconds: 3,
      longestSeconds: 2,
      coveredSeconds: 4,
      unknownSeconds: 5,
      firstAt: 1,
      lastAt: 8,
    })
    expect(row.initial).toEqual({ value: 1, time: 0, frame: 0 })
    expect(row.final).toEqual({ value: 1, time: 9, frame: 8 })
  })
  it('only reports settling for the final continuous observed in-band span', () => {
    const row = result()
    const measure = new Measurements(row, [
      { kind: 'settling', after: 1, band: [0.9, 1.1], holdSeconds: 2, maxGapSeconds: 1 },
    ])
    for (let time = 0; time <= 4; time++) measure.add(time, time, 1)
    expect(row.settling).toEqual({ settledAt: 1, observedThrough: 4, heldSeconds: 3 })
    measure.add(5, 5, 0.8)
    expect(row.settling!.settledAt).toBeNull()
    for (let time = 6; time <= 8; time++) measure.add(time, time, 1)
    expect(row.settling!.settledAt).toBe(6)
    measure.add(10, 9, 1)
    expect(row.settling).toEqual({ settledAt: null, observedThrough: 10, heldSeconds: 0 })
    measure.add(11, 10, null)
    expect(row.settling!.settledAt).toBeNull()
  })
  it('requires explicit duration and gap assumptions and preserves missing endpoints', () => {
    expect(() => validateMetrics([{ ...threshold, lower: undefined }])).toThrow(/bounds/)
    expect(() => validateMetrics([threshold, threshold])).toThrow(/once/)
    expect(() => validateMetrics([{ ...threshold, maxGapSeconds: 0 }])).toThrow(/positive/)
    const row = result()
    const measure = new Measurements(row, [{ kind: 'initial-final' }])
    measure.add(0, 0, null)
    measure.add(1, 1, 1)
    measure.add(2, 2, NaN)
    expect(row).toMatchObject({ initial: null, final: null })
  })
})
