import { colormaps } from '@latkit/gpu'
import { describe, expect, it } from 'vitest'

import { reader } from '../../shared/preferences.js'
import type { SimulationInfo } from '../../shared/simulation.js'
import { axisLabel, axisName, holds, monitorWindow, plotBindings, plotOptions } from './plot.js'

describe('the window a plot shows', () => {
  it('keeps the configured interval before samples, during streaming, and after completion or cancellation', () => {
    for (const state of ['running', 'complete', 'cancelled'] as const)
      for (const end of [0, 0.1, 3, 9.99, 10]) {
        const run = { state, span: [0, 10] as const, domain: [0, end] as const }
        expect(monitorWindow(run)).toEqual([0, 10])
        expect(monitorWindow(run, [2, 4])).toEqual([2, 4])
      }
  })
  it('uses recorded bounds for imports and a nonzero initial axis', () => {
    expect(monitorWindow({ domain: [2, 7] })).toEqual([2, 7])
    expect(monitorWindow()).toEqual([0, 1])
  })
})

it('colors a mapped trace by the value it plots, over the run’s recorded range', () => {
  const run = { domains: { Bus: { Vm: [0.5, 1.5] } } } as unknown as SimulationInfo
  const binding = { type: 'Bus', field: 'Vm' }
  for (const id of [undefined, 'Bus/1']) {
    const { traces } = plotBindings(
      reader(),
      { ...binding, id },
      { vertexColor: binding },
      undefined,
      run,
    )
    // Colored by its own field, with no rows of its own: the plot keeps only where lines lie.
    expect(traces.plotted!.color).toMatchObject({ field: 'Vm', domain: [0.5, 1.5] })
    expect(traces.plotted!.color).not.toHaveProperty('rows')
  }
  const { traces } = plotBindings(
    reader(),
    binding,
    { vertexColor: { ...binding, domain: [0, 2] } },
    undefined,
    run,
  )
  expect(traces.plotted!.color).toMatchObject({ domain: [0, 2] })
})

it('waits for the samples a plot draws: its field, for its row or for every row', () => {
  const one = { from: 'Bus', select: ['Vm'], rows: { kind: 'ids' as const, ids: ['Bus/1'] } }
  const every = { from: 'Bus', select: ['Vm'] }
  expect(holds([one], { type: 'Bus', field: 'Vm', id: 'Bus/1' })).toBe(true)
  // A plot of every bus, added beside one of a single bus, waits for the samples of all of them.
  expect(holds([one], { type: 'Bus', field: 'Vm' })).toBe(false)
  expect(holds([every], { type: 'Bus', field: 'Vm' })).toBe(true)
  expect(holds([every], { type: 'Bus', field: 'Va' })).toBe(false)
})

it('changes only a trace’s color when live extrema or the colormap change', () => {
  const field = { type: 'Bus', field: 'Vm' }
  const bindings = { vertexColor: field }
  const config = (range: [number, number], palette: 'batlow' | 'viridis') =>
    plotBindings(reader({ 'network.colormap': palette }), field, bindings, undefined, {
      domains: { Bus: { Vm: range } },
    } as unknown as SimulationInfo).traces.plotted!
  const before = config([1, 1], 'batlow')
  const after = config([0.2, 1.8], 'viridis')
  expect({ ...after, color: undefined }).toEqual({ ...before, color: undefined })
  expect(after.color).not.toEqual(before.color)
  expect(plotBindings(reader(), field, {}, undefined).traces.plotted).not.toHaveProperty('color')
})

it('replaces the plotted field in place, under one trace', () => {
  const { traces } = plotBindings(reader(), { type: 'Hub', field: 'level' })
  expect(Object.keys(traces)).toEqual(
    Object.keys(plotBindings(reader(), { type: 'Line', field: 'flow' }).traces),
  )
  expect(Object.values(traces)[0]).toMatchObject({ from: 'Hub', y: 'level' })
  expect(Object.values(traces)[0]).not.toHaveProperty('color')
})

it('colors a field as the network colors it: its colormap, over the same range', () => {
  const s = reader({ 'network.colormap': 'batlow' })
  const vertexColor = { type: 'Hub', field: 'level', domain: [0.5, 1.5] as const }
  const config = plotBindings(s, { type: 'Hub', field: 'level' }, { vertexColor })
  expect(config.traces.plotted!.color).toMatchObject({
    field: 'level',
    domain: [0.5, 1.5],
    colormap: colormaps.batlow,
  })
  const height = { vertexHeight: vertexColor }
  expect(
    Object.values(plotBindings(s, { type: 'Hub', field: 'level' }, height).traces)[0],
  ).not.toHaveProperty('color')
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
