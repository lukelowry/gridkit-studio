import { createRequire } from 'node:module'

import { Data, Expr } from 'latkit'
import { beforeAll, expect, it } from 'vitest'

import { catalog } from '../gridkit/definition.js'
import { reader } from '../shared/preferences.js'
import { loadNative } from '../workers/native.js'
import {
  caseFit,
  diagramScene,
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
  expect(network.layout).toBe('stress')
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
  const projected = sceneFields(catalog.definition, 'network', {
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
  // has no lane, names itself on its value axis. Neither titles the time axis.
  expect(monitored.space).toEqual({ plot: { y: { label: null } } })
  expect(plotScene(data, plot, settings, {}, 'Bus · Vm').space).toEqual({
    plot: { y: { label: 'Bus · Vm' } },
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
it('frames whole case tables and raises geographic heights by meters', () => {
  using data = new Data('case').replace('Bus', [1, 2], {
    x: [0, 1],
    y: [0, 1],
    kv: [0, 10],
  })
  const drawing = {
    geographic: true,
    vertices: [{ table: 'Bus', position: ['x', 'y'] as [string, string] }],
    edges: [],
    blocks: [],
    nets: [],
  }
  expect(JSON.parse(JSON.stringify(caseFit(data, drawing, 'network')))).toEqual({
    tables: [['case', 'Bus']],
  })
  // 111,194.93 meters is one degree of arc, the earth's unit of height.
  const scene = networkScene(data, drawing, reader({ 'network.heightMeters': 111194.93 }), {}, [
    { table: 'Bus', field: 'kv', channel: 'elevation', domain: [0, 10] },
  ])
  const elevation = (scene.marks![0] as { elevation: Expr }).elevation
  const values = data.query({ of: 'Bus', select: { elevation } }).fields.elevation as Float64Array
  expect(values[0]).toBeCloseTo(0)
  expect(values[1]).toBeCloseTo(1, 6)
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
  const larger = sizes(reader({ 'network.vertexRadius': 5, 'network.edgeWidth': 1.5 }))
  expect(larger.radius).toBe(dense.radius * 2)
  expect(larger.width).toBe(dense.width * 2)

  const scene = networkScene(data, drawing, reader(), {}, [
    { table: 'Bus', field: 'value', channel: 'radius', domain: [0, 10] },
    { table: 'Line', field: 'value', channel: 'width', domain: [0, 10] },
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
  expect(sparse.marks![1]).toMatchObject({ radius: 2.5 })
  expect(sparse.marks![0]).toMatchObject({ width: 0.75 })
})
