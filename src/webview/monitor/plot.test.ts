import { colormaps } from '@latkit/gpu'
import { describe, expect, it } from 'vitest'

import { reader } from '../../shared/preferences.js'
import type { Results } from '../../shared/simulation.js'
import {
  axisLabel,
  axisName,
  holds,
  monitorWindow,
  plotBindings,
  plotOptions,
  streamedValues,
} from './plot.js'

describe('the values a streamed plot spans', () => {
  const voltage = { from: 'Bus', field: 'Vm' }
  const measured = (min: number, max: number) => ({ domains: { Bus: { Vm: [min, max] as const } } })

  it("spans the field's measured range, and grows by half again only past it", () => {
    const first = streamedValues(measured(0.9, 1.1), voltage)!
    expect(first[0]).toBeLessThan(0.9)
    expect(first[1]).toBeGreaterThan(1.1)
    // Extremes within it keep it, so nothing draws again.
    expect(streamedValues(measured(0.95, 1.05), voltage, first)).toBe(first)
    // Past it, half the measured range again on each side.
    const grown = streamedValues(measured(0.5, 1.1), voltage, first)!
    expect(grown[0]).toBeCloseTo(0.2)
    expect(grown[1]).toBeCloseTo(1.4)
    // Unmeasured, it keeps what it spans; a flat field still spans values.
    expect(streamedValues(undefined, voltage, first)).toBe(first)
    const flat = streamedValues(measured(1, 1), voltage)!
    expect(flat[1]).toBeGreaterThan(flat[0])
  })
})

describe('the window a plot shows', () => {
  it('keeps the configured interval before samples, during streaming, and after completion or cancellation', () => {
    for (const growing of [true, false])
      for (const end of [0, 0.1, 3, 9.99, 10]) {
        const results = { growing, span: [0, 10] as const, domain: [0, end] as const }
        expect(monitorWindow(results)).toEqual([0, 10])
        expect(monitorWindow(results, [2, 4])).toEqual([2, 4])
      }
  })
  it('uses the recorded bounds of results opened, and a nonzero initial axis', () => {
    expect(monitorWindow({ domain: [2, 7] })).toEqual([2, 7])
    expect(monitorWindow()).toEqual([0, 1])
  })
})

it('colors a mapped trace by the value it plots, over the results’ recorded range', () => {
  const results = { domains: { Bus: { Vm: [0.5, 1.5] } } } as unknown as Results
  const binding = { type: 'Bus', field: 'Vm' }
  for (const id of [undefined, 'Bus/1']) {
    const { traces } = plotBindings(
      reader(),
      { from: 'Bus', field: 'Vm', id },
      { vertexColor: binding },
      undefined,
      results,
    )
    // Colored by its own field, with no rows of its own: the plot keeps only where lines lie.
    expect(traces.plotted!.color).toMatchObject({ field: 'Vm', domain: [0.5, 1.5] })
    expect(traces.plotted!.color).not.toHaveProperty('rows')
  }
  const { traces } = plotBindings(
    reader(),
    { from: 'Bus', field: 'Vm' },
    { vertexColor: { ...binding, domain: [0, 2] } },
    undefined,
    results,
  )
  expect(traces.plotted!.color).toMatchObject({ domain: [0, 2] })
})

it('waits for the samples a plot draws: its field, for its row or for every row', () => {
  const one = { from: 'Bus', select: ['Vm'], rows: { kind: 'ids' as const, ids: ['Bus/1'] } }
  const every = { from: 'Bus', select: ['Vm'] }
  expect(holds([one], { from: 'Bus', field: 'Vm', id: 'Bus/1' })).toBe(true)
  // A plot of every bus, added beside one of a single bus, waits for the samples of all of them.
  expect(holds([one], { from: 'Bus', field: 'Vm' })).toBe(false)
  expect(holds([every], { from: 'Bus', field: 'Vm' })).toBe(true)
  expect(holds([every], { from: 'Bus', field: 'Va' })).toBe(false)
})

it('changes only a trace’s color when live extrema or the colormap change', () => {
  const plot = { from: 'Bus', field: 'Vm' }
  const bindings = { vertexColor: { type: 'Bus', field: 'Vm' } }
  const config = (range: [number, number], palette: 'batlow' | 'viridis') =>
    plotBindings(reader({ 'network.colormap': palette }), plot, bindings, undefined, {
      domains: { Bus: { Vm: range } },
    } as unknown as Results).traces.plotted!
  const before = config([1, 1], 'batlow')
  const after = config([0.2, 1.8], 'viridis')
  expect({ ...after, color: undefined }).toEqual({ ...before, color: undefined })
  expect(after.color).not.toEqual(before.color)
  expect(plotBindings(reader(), plot, {}, undefined).traces.plotted).not.toHaveProperty('color')
})

it('replaces the plotted field in place, under one trace', () => {
  const { traces } = plotBindings(reader(), { from: 'Hub', field: 'level' })
  expect(Object.keys(traces)).toEqual(
    Object.keys(plotBindings(reader(), { from: 'Line', field: 'flow' }).traces),
  )
  expect(Object.values(traces)[0]).toMatchObject({ from: 'Hub', y: 'level' })
  expect(Object.values(traces)[0]).not.toHaveProperty('color')
})

it('colors a field as the network colors it: its colormap, over the same range', () => {
  const s = reader({ 'network.colormap': 'batlow' })
  const vertexColor = { type: 'Hub', field: 'level', domain: [0.5, 1.5] as const }
  const config = plotBindings(s, { from: 'Hub', field: 'level' }, { vertexColor })
  expect(config.traces.plotted!.color).toMatchObject({
    field: 'level',
    domain: [0.5, 1.5],
    colormap: colormaps.batlow,
  })
  const height = { vertexHeight: vertexColor }
  expect(
    Object.values(plotBindings(s, { from: 'Hub', field: 'level' }, height).traces)[0],
  ).not.toHaveProperty('color')
})

it('names the time axis in sentence case, and leaves the values to the signal menu', () => {
  expect(axisName({ name: 'time', unit: 's' })).toBe('Time')
  expect(axisLabel({ name: 'time', unit: 's' })).toBe('Time (s)')
  expect(axisLabel(undefined)).toBe('Coordinate')
  expect(plotOptions(reader(), null, null, { ticks: true, time: 'Time (s)' })).toMatchObject({
    xAxis: { label: 'Time (s)', tickLabels: true },
    yAxis: { label: '' },
  })
})

it('outlines each plot, and labels the time ticks of the last of those stacked over one axis', () => {
  const above = plotOptions(reader(), null, null, { ticks: false, time: 'Time (s)' })
  expect(above).toMatchObject({
    outline: true,
    xAxis: { label: '', tickLabels: false, grid: true },
  })
  const last = plotOptions(reader(), null, null, { ticks: true, caption: 'Bus · Vm' })
  expect(last).toMatchObject({
    outline: true,
    xAxis: { tickLabels: true },
    yAxis: { label: 'Bus · Vm' },
  })
})

it('draws every trace in the chosen color and width', () => {
  const s = reader({ 'monitor.traceColor': '#ff0000', 'monitor.traceWidthPx': 2 })
  expect(plotOptions(s, null, null, { ticks: true })).toMatchObject({
    traceColor: [1, 0, 0, 1],
    traceWidthPx: 2,
  })
})
