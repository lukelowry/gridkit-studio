import { createRequire } from 'node:module'

import { Data, Expr, type Mark, reference } from 'latkit'
import { beforeAll, expect, it } from 'vitest'

import { catalog } from '../gridkit/definition.js'
import { defaults, reader } from '../shared/preferences.js'
import { loadNative } from '../workers/native.js'
import {
  caseFit,
  caseSpan,
  diagramScene,
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
  expect(network.controls).toMatchObject({ keyboard: true, motion: 'system' })
  const diagram = diagramScene(data, catalog.definition.drawing, settings, {}, true)
  expect(diagram.layout).toEqual({
    layered: {
      direction: settings.get('diagram.direction'),
      gap: settings.get('diagram.gap'),
      rankGap: settings.get('diagram.rankGap'),
    },
  })
  expect(diagram.controls).toMatchObject({ connect: true, delete: true })
  const projected = sceneFields(catalog.definition, ['network'], {
    vertexColor: { table: 'Bus', field: 'Vm' },
  })
  expect(projected.flatMap((table) => table.fields)).not.toContain('Vm')
  expect(projected.find((table) => table.table === 'Branch')?.fields).toContain('ports.bus1')
  const plot = { from: 'Bus', field: 'Vm' }
  const monitored = plotScene(data, plot, settings, {})
  expect(monitored.marks).toMatchObject([
    { trace: 'Vm', interpolation: 'linear', width: settings.get('monitor.lineWidth') },
  ])
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
    blocks: [],
    nets: [],
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
  const drawing = (geographic: boolean) => ({ geographic, vertices, edges, blocks: [], nets: [] })
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
  expect(JSON.parse(JSON.stringify(caseFit(earth, drawing(true), 'network')))).toEqual({
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

it('draws buses over branches seen flat, and branches after buses where depth decides', () => {
  using data = new Data('case').replace('Bus', [1], { x: [0], y: [0] })
  const drawing = {
    geographic: true,
    vertices: [{ table: 'Bus', position: ['x', 'y'] as [string, string] }],
    edges: [{ table: 'Branch' }],
    blocks: [],
    nets: [],
  }
  const coast: Mark = { lines: ['map:coastline', 'lines'], name: 'map:coastline' }
  const kinds = (settings: ReturnType<typeof reader>) =>
    networkScene(data, drawing, settings, {}, [], [coast]).marks!.map((mark) =>
      'lines' in mark ? 'lines' : 'vertices' in mark ? 'vertices' : 'edges',
    )
  expect(kinds(reader())).toEqual(['lines', 'edges', 'vertices'])
  expect(kinds(reader({ 'network.tilt': 45 }))).toEqual(['lines', 'vertices', 'edges'])
  expect(kinds(reader({ 'network.projection': 'globe' }))).toEqual(['lines', 'vertices', 'edges'])
})

it('scales dense case marks and their bindings together while preserving missing rows', () => {
  const drawing = {
    geographic: true,
    vertices: [{ table: 'Bus', position: ['x', 'y'] as [string, string] }],
    edges: [{ table: 'Line' }],
    blocks: [],
    nets: [],
  }
  using data = new Data('case')
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
  const sizes = (settings = reader()) => {
    const scene = networkScene(data, drawing, settings, {}, [])
    return {
      radius: (scene.marks![1] as { radius: number }).radius,
      width: (scene.marks![0] as { width: number }).width,
    }
  }
  const dense = sizes()
  expect(dense.radius).toBeGreaterThan(0.3)
  expect(dense.radius).toBeLessThan(0.7)
  expect(dense.width).toBeGreaterThan(0.2)
  expect(dense.width).toBeLessThan(0.5)
  const larger = sizes(
    reader({
      'network.vertexRadius': 2 * defaults['network.vertexRadius'],
      'network.edgeWidth': 2 * defaults['network.edgeWidth'],
    }),
  )
  expect(larger.radius).toBe(dense.radius * 2)
  expect(larger.width).toBe(dense.width * 2)

  const scene = networkScene(data, drawing, reader(), {}, [
    { table: 'Bus', field: 'value', placement: 'vertex', channel: 'radius', domain: [0, 10] },
    { table: 'Line', field: 'value', placement: 'edge', channel: 'width', domain: [0, 10] },
  ])
  for (const [table, mark, channel, high] of [
    ['Bus', 1, 'radius', 2.5],
    ['Line', 0, 'width', 4],
  ] as const) {
    const spec = scene.marks![mark]!
    const expression = 'vertices' in spec ? spec.radius : 'edges' in spec ? spec.width : undefined
    if (!(expression instanceof Expr)) throw new Error('Expected a native size expression.')
    const values = data.query({ of: table, ids: [0, 1, 2], select: { size: expression } }).fields
      .size
    expect(Array.from(values as Float64Array)).toEqual([
      dense[channel] * 0.5,
      dense[channel] * high,
      dense[channel],
    ])
  }
  using small = new Data('small').replace('Bus', [1, 2]).replace('Line', [1])
  const sparse = networkScene(small, drawing, reader(), {}, [])
  // A sparse case keeps the sizes the settings give.
  expect(sparse.marks![1]).toMatchObject({ radius: defaults['network.vertexRadius'] })
  expect(sparse.marks![0]).toMatchObject({ width: defaults['network.edgeWidth'] })
})
