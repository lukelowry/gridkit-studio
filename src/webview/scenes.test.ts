import { createRequire } from 'node:module'

import { Data, Expr, type Mark, reference } from 'latkit'
import { beforeAll, expect, it } from 'vitest'

import { catalog } from '../gridkit/definition.js'
import { defaults, EDGE_WIDTH, reader } from '../shared/preferences.js'
import { loadNative } from '../workers/native.js'
import {
  caseFit,
  caseSpan,
  GAP,
  networkScene,
  plotScene,
  sampledFields,
  sceneBindings,
  sceneFields,
} from './scenes.js'
beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))
it('builds native scenes and projects only mark fields with separate sampled sources', () => {
  using data = new Data('case')
  const settings = reader()
  const network = networkScene(data, catalog.definition.drawing, settings, {}, [])
  expect(network.layout).toEqual({ stress: { gap: GAP } })
  // The wheel's default leaves every input to latkit.
  expect(network.controls).toEqual(
    expect.objectContaining({ keyboard: true, motion: 'system', gestures: {} }),
  )
  // A trackpad scrolls a canvas to pan and pinches to zoom.
  const trackpad = reader({ 'network.zoom': 'trackpad' })
  expect(networkScene(data, catalog.definition.drawing, trackpad, {}, []).controls).toMatchObject({
    gestures: { wheel: 'pan', 'control+wheel': 'zoom' },
  })
  const projected = sceneFields(catalog.definition, {
    vertexColor: { table: 'Bus', field: 'Vm' },
  })
  expect(projected.flatMap((table) => table.fields)).not.toContain('Vm')
  expect(projected.find((table) => table.table === 'Branch')?.fields).toContain('ports.bus1')
  const plot = { from: 'Bus', field: 'Vm' }
  const monitored = plotScene(data, plot, settings, {})
  expect(monitored.marks).toMatchObject([
    { trace: 'Vm', interpolation: 'linear', width: settings.get('monitor.lineWidth') },
  ])
  // Shift and a drag frames a span of time; a wheel turned off neither zooms nor pinches.
  expect(monitored.controls).toMatchObject({ gestures: { 'shift+primary': 'zoomBox' } })
  expect(plotScene(data, plot, reader({ 'monitor.zoom': 'off' }), {}).controls).toMatchObject({
    gestures: { wheel: 'none', pinch: 'none', 'shift+primary': 'zoomBox' },
  })
  // The Monitor's lanes name their plots, whose axes carry ticks alone; a picture's plot, which
  // has no lane, names itself on its value axis. Neither titles the time axis: its last tick says
  // it is seconds.
  expect(monitored.space).toEqual({ plot: { x: { unit: ' s' }, y: { label: null } } })
  expect(plotScene(data, plot, settings, {}, 'Bus · Vm').space).toEqual({
    plot: { x: { unit: ' s' }, y: { label: 'Bus · Vm' } },
  })
})
it('joins sparse sampled bindings by ID with a stable whole-run domain', () => {
  using data = new Data('case').replace('Bus', [42, 99], { x: [0, 1], y: [0, 1] })
  using sampled = new Data('sample')
    .axis('time', 's')
    .replace('Bus', [42])
    .frames('Bus', 'Vm', { first: 0, at: [0, 1], values: [1, 2] })
  const bindings = sceneBindings(
    catalog.definition,
    { vertexSize: { table: 'Bus', field: 'Vm' } },
    [{ table: 'Bus', field: 'Vm', ids: [42], domain: [0, 10] }],
    () => sampled,
  )
  expect(bindings[0]?.domain).toEqual([0, 10])
  expect(bindings[0]?.source).toEqual(['sample', 'Bus'])
  const drawing = {
    geographic: false,
    vertices: [{ table: 'Bus', position: ['x', 'y'] as [string, string] }],
    edges: [],
  }
  const scene = networkScene(data, drawing, reader(), {}, bindings)
  const radius = (scene.marks![0] as { radius: Expr }).radius
  expect(JSON.stringify(radius)).toContain('sample')
  const results = {
    outputs: [{ table: 'Bus', field: 'Vm', ids: [42] }],
  } as unknown as Parameters<typeof sampledFields>[2]
  const both = {
    vertexSize: { table: 'Bus', field: 'Vm' },
    edgeColor: { table: 'Bus', field: 'Vm' },
  }
  expect(sampledFields(catalog.definition, both, results)).toEqual([['Bus', 'Vm']])
  expect(sampledFields(catalog.definition, both)).toEqual([])
})
it("frames whole case tables, and raises the highest mapped value a share of the case's span", () => {
  const vertices = [{ table: 'Bus', position: ['x', 'y'] as [string, string] }]
  const edges = [{ table: 'Line', ends: ['from', 'to'] as [string, string] }]
  const drawing = (geographic: boolean) => ({ geographic, vertices, edges })
  /** The heights of the lowest and highest of `v`, raised a fifth of the span. */
  const raised = (data: Data, geographic: boolean) => {
    const scene = networkScene(data, drawing(geographic), reader({ 'network.height': 0.2 }), {}, [
      { table: 'Bus', field: 'v', placement: 'vertex', channel: 'elevation', domain: [0, 10] },
    ])
    const { elevation } = scene.marks!.find((mark) => 'vertices' in mark) as { elevation: Expr }
    const values = data.query({ of: 'Bus', select: { elevation } }).fields.elevation as Float64Array
    return [values[0], values.at(-1)]
  }
  // On the earth, 3° east and 4° north of each other near the equator: 5° of arc across.
  using earth = new Data('earth').replace('Bus', [1, 2], { x: [0, 3], y: [0, 4], v: [0, 10] })
  expect(JSON.parse(JSON.stringify(caseFit(earth, drawing(true))))).toEqual({
    tables: [
      ['earth', 'Bus'],
      ['earth', 'Line'],
    ],
  })
  const [ground, top] = raised(earth, true)
  expect(ground).toBe(0)
  expect(top).toBeCloseTo(0.2 * caseSpan(earth, drawing(true)))
  expect(caseSpan(earth, drawing(true))).toBeCloseTo(5, 2)
  // On a plane, five buses in a row, an island of one beside them: four links across the longest.
  using plane = new Data('plane')
    .replace('Bus', [1, 2, 3, 4, 5, 6], { v: [0, 0, 0, 0, 0, 10] })
    .replace('Line', [1, 2, 3, 4], {
      from: reference('Bus', [1, 2, 3, 4]),
      to: reference('Bus', [2, 3, 4, 5]),
    })
  expect(caseSpan(plane, drawing(false))).toBe(4 * GAP)
  expect(raised(plane, false)[1]).toBeCloseTo(0.2 * 4 * GAP)
})

it('draws the map, then branches, then the buses over them, however the network is seen', () => {
  using data = new Data('case').replace('Bus', [1], { x: [0], y: [0] })
  const drawing = {
    geographic: true,
    vertices: [{ table: 'Bus', position: ['x', 'y'] as [string, string] }],
    edges: [{ table: 'Branch' }],
  }
  const coast: Mark = { lines: ['map:coastline', 'lines'], name: 'map:coastline' }
  const kinds = (settings: ReturnType<typeof reader>) =>
    networkScene(data, drawing, settings, {}, [], [coast]).marks!.map((mark) =>
      'lines' in mark ? 'lines' : 'vertices' in mark ? 'vertices' : 'edges',
    )
  for (const settings of [{}, { 'network.tilt': 45 }, { 'network.projection': 'globe' as const }])
    expect(kinds(reader(settings))).toEqual(['lines', 'edges', 'vertices'])
})

it('draws every case at the sizes the settings give, a vertex past its edges', () => {
  const drawing = {
    geographic: true,
    vertices: [{ table: 'Bus', position: ['x', 'y'] as [string, string] }],
    edges: [{ table: 'Line' }],
  }
  using dense = new Data('dense')
    .replace(
      'Bus',
      Array.from({ length: 70_000 }, (_, id) => id),
    )
    .replace(
      'Line',
      Array.from({ length: 95_000 }, (_, id) => id),
    )
    .set('Bus', [0, 1, 2], { value: Float64Array.of(0, 10, NaN) })
    .set('Line', [0, 1, 2], { value: Float64Array.of(0, 10, NaN) })
  using sparse = new Data('sparse').replace('Bus', [1, 2]).replace('Line', [1])
  const sizes = (data: Data, settings = reader()) => {
    const scene = networkScene(data, drawing, settings, {}, [])
    return {
      radius: (scene.marks![1] as { radius: number }).radius,
      width: (scene.marks![0] as { width: number }).width,
    }
  }
  // However many rows a case has.
  const given = {
    radius: defaults['network.vertexRadius'],
    width: defaults['network.edgeWidth'],
  }
  expect(sizes(dense)).toEqual(given)
  expect(sizes(sparse)).toEqual(given)
  // A vertex is never narrower than twice its edges, whatever the two settings.
  const wide = reader({ 'network.vertexRadius': EDGE_WIDTH, 'network.edgeWidth': 3 * EDGE_WIDTH })
  expect(sizes(dense, wide)).toEqual({ radius: 3 * EDGE_WIDTH, width: 3 * EDGE_WIDTH })

  // A mapped size spans the mark's own to three times it; a row without a value keeps its own.
  const scene = networkScene(dense, drawing, reader(), {}, [
    { table: 'Bus', field: 'value', placement: 'vertex', channel: 'radius', domain: [0, 10] },
    { table: 'Line', field: 'value', placement: 'edge', channel: 'width', domain: [0, 10] },
  ])
  for (const [table, mark, channel] of [
    ['Bus', 1, 'radius'],
    ['Line', 0, 'width'],
  ] as const) {
    const spec = scene.marks![mark]!
    const expression = 'vertices' in spec ? spec.radius : 'edges' in spec ? spec.width : undefined
    if (!(expression instanceof Expr)) throw new Error('Expected a native size expression.')
    const values = dense.query({ of: table, ids: [0, 1, 2], select: { size: expression } }).fields
      .size
    expect(Array.from(values as Float64Array)).toEqual([
      given[channel],
      3 * given[channel],
      given[channel],
    ])
  }
})
