import { describe, expect, it } from 'vitest'

import { reader } from '../../shared/preferences.js'
import { axisLabel, axisName, plotOptions, tracesOf, windowOf } from './plot.js'

describe('the window a plot shows', () => {
  it('rounds a growing run’s end up to a power of two of its span, and fits a run that ended', () => {
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
  expect(Object.values(traces)[0]).toMatchObject({ from: 'Hub', y: 'level' })
})

it('names the time axis in sentence case, and leaves the values to the signal menu', () => {
  expect(axisName({ name: 'time', unit: 's' })).toBe('Time')
  expect(axisLabel({ name: 'time', unit: 's' })).toBe('Time (s)')
  expect(axisLabel(undefined)).toBe('Coordinate')
  expect(plotOptions(reader(), null, null, 'Time (s)', '')).toMatchObject({
    xAxis: { label: 'Time (s)' },
    yAxis: {},
  })
})

it('draws every trace in the chosen color and width', () => {
  const s = reader({ 'monitor.traceColor': '#ff0000', 'monitor.traceWidthPx': 2 })
  expect(plotOptions(s, null, null, '', '')).toMatchObject({
    traceColor: [1, 0, 0, 1],
    traceWidthPx: 2,
  })
})
