import { describe, expect, it } from 'vitest'

import { reader } from '../../preferences.js'
import { axisLabel, axisName, coordinateAt, plotOptions, tracesOf, windowOf } from './plot.js'

describe('the window a plot shows', () => {
  it('rounds a growing run’s end up to a power of two of its span, and fits a run that ended', () => {
    expect(windowOf(null, true)).toEqual([0, 1])
    expect(windowOf([0, 3], true)).toEqual([0, 4])
    expect(windowOf([0, 9.99], true)).toEqual([0, 16])
    expect(windowOf([2, 2.5], true)).toEqual([2, 2.5])
    expect(windowOf([0, 9.99], false)).toEqual([0, 9.99])
    expect(windowOf([5, 5], true)).toEqual([5, 5])
  })
})

it('replaces the plotted field in place, under one trace', () => {
  const traces = tracesOf(reader(), { type: 'Hub', field: 'level' })
  expect(Object.keys(traces)).toEqual(
    Object.keys(tracesOf(reader(), { type: 'Line', field: 'flow' })),
  )
})

it('scrubs continuously across the plot area, independent of trace proximity', () => {
  // The value labels take 84 px at the left, the time axis 36 px below, and 12 px stay at the right.
  expect(coordinateAt([84, 100], 600, 200, [10, 20], {})).toBe(10)
  expect(coordinateAt([336, 100], 600, 200, [10, 20], {})).toBe(15)
  expect(coordinateAt([588, 100], 600, 200, [10, 20], {})).toBe(20)
  expect(coordinateAt([83, 100], 600, 200, [10, 20], {})).toBeNull()
  expect(coordinateAt([300, 7], 600, 200, [10, 20], {})).toBeNull()
  expect(coordinateAt([300, 165], 600, 200, [10, 20], {})).toBeNull()
})

it('names the time axis in sentence case, and leaves the values to the signal menu', () => {
  expect(axisName({ name: 'time', unit: 's' })).toBe('Time')
  expect(axisLabel({ name: 'time', unit: 's' })).toBe('Time (s)')
  expect(axisLabel(undefined)).toBe('Coordinate')
  expect(plotOptions(reader(), null, null, 'Time (s)', '')).toMatchObject({
    coordinateAxis: { label: 'Time (s)' },
    valueAxis: {},
  })
})

it('keeps scrubbing aligned when axes and font sizes change', () => {
  expect(
    coordinateAt([0, 30], 600, 200, [0, 10], { valueAxis: false, coordinateAxis: false }),
  ).toBe(0)
  expect(coordinateAt([139, 60], 600, 200, [0, 10], { fontSizePx: 20 })).toBeNull()
  expect(coordinateAt([140, 60], 600, 200, [0, 10], { fontSizePx: 20 })).toBe(0)
  expect(
    coordinateAt([140, 20], 600, 200, [0, 10], { fontSizePx: 20, valueAxis: { label: 'Value' } }),
  ).toBeNull()
})
