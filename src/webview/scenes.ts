import {
  type ColormapName,
  type Data,
  type Expr,
  field,
  type Fit,
  type Mark,
  type Scene,
  type Source,
  type TableInput,
  type Theme,
  when,
} from 'latkit'

import { type Bindings, type Channel, CHANNELS } from '../shared/bindings.js'
import type { ProjectionSelection, RecordedField } from '../shared/data.js'
import { type CaseDefinition, type Drawing, fieldDefinition } from '../shared/document.js'
import type { SettingsReader } from '../shared/preferences.js'

/** Background geography does not determine the extent of the case being inspected. */
export function caseFit(data: Data, drawing: Drawing, kind: 'network' | 'diagram'): Fit {
  const tables =
    kind === 'network'
      ? [...drawing.vertices, ...drawing.edges].map((item) => item.table)
      : [...drawing.blocks.map((item) => item.table), ...drawing.nets]
  return {
    rows: [...new Set(tables)].map((table) => ({
      data: data.name,
      table,
      ids: data.query({ of: table, select: {} }).ids,
    })),
  }
}

export interface Binding {
  readonly table: string
  readonly field: string
  readonly channel: 'color' | 'radius' | 'elevation' | 'width' | 'dash'
  readonly source?: TableInput
  readonly domain?: readonly [number, number]
  readonly range?: readonly [number, number]
}

export function stableDomain(domain: readonly [number, number]): [number, number] {
  const [low, high] = domain
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high)
    throw new Error('Invalid mapping domain.')
  const epsilon = Math.max(Math.abs(low) * 1e-6, 1e-6)
  return low === high ? [low - epsilon, high + epsilon] : [low, high]
}

interface NetworkSizes {
  readonly radius: number
  readonly width: number
}

/** Count only case marks, never map geometry. Metadata reads do not materialize row columns. */
function networkSizes(data: Data, drawing: Drawing, settings: SettingsReader): NetworkSizes {
  const rows = new Map(data.describe().tables.map((table) => [table.name, table.rows]))
  const count = (tables: readonly string[]) =>
    [...new Set(tables)].reduce((sum, table) => sum + (rows.get(table) ?? 0), 0)
  const vertices = count(drawing.vertices.map((vertex) => vertex.table))
  const edges = count(drawing.edges.map((edge) => edge.table))
  // A sparse case keeps its configured size. Reduce ink smoothly as the graph grows;
  // strokes shrink more gently than radii, whose occupied area grows quadratically.
  const density = Math.min(1, (1000 / Math.max(1, vertices, edges / 2)) ** 0.4)
  return {
    radius: settings.get('network.vertexRadius') * Math.max(0.08, density),
    width: settings.get('network.edgeWidth') * Math.max(0.15, Math.sqrt(density)),
  }
}

function mapped(binding: Binding, map: ColormapName, sizes: NetworkSizes): Expr {
  let value = field(binding.field)
  if (binding.source) value = value.from(binding.source)
  if (binding.channel === 'dash') return value.gt(0)
  const defaults = { radius: [0.5, 2.5], elevation: [0, 1], width: [0.5, 4] } as const
  const output =
    binding.channel === 'color'
      ? value.colormap(map)
      : value.scale(...(binding.range ?? defaults[binding.channel]))
  const mapped = binding.domain ? output.domain(...stableDomain(binding.domain)) : output
  if (binding.channel !== 'radius' && binding.channel !== 'width') return mapped
  // Missing sampled rows retain the ordinary case size instead of a theme-sized fallback.
  const size = sizes[binding.channel]
  return when(value.eq(value)).then(mapped.mul(size)).otherwise(size)
}

function channels(
  table: string,
  bindings: readonly Binding[],
  map: ColormapName,
  vertex: boolean,
  sizes: NetworkSizes,
): Record<string, Expr> {
  const allowed = vertex ? ['color', 'radius', 'elevation'] : ['color', 'width', 'dash']
  return Object.fromEntries(
    bindings
      .filter((binding) => binding.table === table && allowed.includes(binding.channel))
      .map((binding) => [binding.channel, mapped(binding, map, sizes)]),
  )
}

export function sceneBindings(
  definition: CaseDefinition,
  bindings: Bindings,
  outputs: readonly RecordedField[],
  sampled: (table: string, field: string) => Source | undefined,
  settings: SettingsReader,
): Binding[] {
  return Object.entries(bindings).flatMap(([key, binding]) => {
    const channel = CHANNELS[key as Channel].option
    const recorded = outputs.find(
      (output) => output.table === binding.table && output.field === binding.field,
    )
    const source = sampled(binding.table, binding.field)
    if (fieldDefinition(definition, binding.table, binding.field)?.kind === 'sampled' && !source)
      return []
    return [
      {
        ...binding,
        channel,
        ...(source && { source: [source.name, binding.table] as const }),
        ...(binding.domain || recorded?.domain
          ? { domain: binding.domain ?? recorded!.domain! }
          : {}),
        ...(channel === 'elevation'
          ? {
              range: [
                0,
                definition.drawing.geographic ? settings.get('network.heightMeters') / 111195 : 1,
              ] as const,
            }
          : {}),
      },
    ]
  })
}

function controls(settings: SettingsReader, kind: 'network' | 'diagram' | 'monitor') {
  return {
    keyboard: true,
    zoom: settings.get(`${kind}.zoom`),
    motion:
      settings.get(`${kind}.motion`) === 'system' &&
      typeof document !== 'undefined' &&
      document.body.classList.contains('vscode-reduce-motion')
        ? ('reduced' as const)
        : settings.get(`${kind}.motion`),
    pickRadius: settings.get(`${kind}.pickRadius`),
  }
}

export function networkScene(
  data: Data,
  drawing: Drawing,
  settings: SettingsReader,
  theme: Theme,
  bindings: readonly Binding[],
  background: readonly Mark[] = [],
): Scene {
  const sizes = networkSizes(data, drawing, settings)
  return {
    space: drawing.geographic
      ? {
          earth: {
            projection: settings.get('network.projection'),
            daylight: settings.get('network.map.daylight') ? Date.now() / 1000 : null,
          },
        }
      : 'plane',
    layout: 'stress',
    theme,
    ease: settings.get('network.ease'),
    controls: { ...controls(settings, 'network'), cycle: true },
    marks: [
      ...background,
      ...drawing.edges.map((edge): Mark => ({
        edges: [data.name, edge.table],
        name: edge.table,
        ...(edge.ends ? { ends: edge.ends } : {}),
        ...(edge.bends ? { bends: edge.bends } : {}),
        width: sizes.width,
        ...channels(edge.table, bindings, settings.get('network.colormap'), false, sizes),
      })),
      ...drawing.vertices.map((vertex): Mark => ({
        vertices: [data.name, vertex.table],
        name: vertex.table,
        position: [field(vertex.position[0]), field(vertex.position[1])],
        label: settings.get('network.labels') && vertex.label ? field(vertex.label) : null,
        radius: sizes.radius,
        ...channels(vertex.table, bindings, settings.get('network.colormap'), true, sizes),
      })),
    ],
  }
}

export function diagramScene(
  data: Data,
  drawing: Drawing,
  settings: SettingsReader,
  theme: Theme,
  editable: boolean,
): Scene {
  const grid = settings.get('diagram.grid')
  return {
    space: {
      diagram: {
        grid:
          grid === 'none'
            ? 'off'
            : grid === 'dots'
              ? { dots: { pitch: 20 } }
              : { lines: { pitch: 20 } },
      },
    },
    layout: {
      layered: {
        direction: settings.get('diagram.direction'),
        gap: settings.get('diagram.gap'),
        rankGap: settings.get('diagram.rankGap'),
      },
    },
    theme,
    ease: settings.get('diagram.ease'),
    controls: { ...controls(settings, 'diagram'), connect: editable, delete: editable },
    marks: [
      ...drawing.nets.map((table): Mark => ({
        edges: [data.name, table],
        name: table,
        route: 'orthogonal',
        arrows: true,
      })),
      ...drawing.blocks.map((block): Mark => ({
        vertices: [data.name, block.table],
        name: block.table,
        marker: 'block',
        position: [field(block.position[0]), field(block.position[1])],
        ports: block.ports,
        drag: editable,
        shadow: true,
        label: settings.get('diagram.labels') && block.label ? field(block.label) : null,
      })),
    ],
  }
}

export function plotScene(
  source: Source,
  table: string,
  trace: string,
  title: string,
  settings: SettingsReader,
  theme: Theme,
): Scene {
  return {
    space: { plot: { x: { label: 'Time [s]' }, y: { label: title } } },
    theme,
    ease: 0,
    controls: controls(settings, 'monitor'),
    marks: [
      {
        lines: [source.name, table],
        trace,
        name: trace,
        width: settings.get('monitor.lineWidth'),
        interpolation: settings.get('monitor.interpolation') === 'step' ? 'stepAfter' : 'linear',
      },
    ],
  }
}

/** Only fields needed by marks; sampled fields live in their own bounded sources. */
export function sceneFields(
  definition: CaseDefinition,
  kind: 'network' | 'diagram',
  bindings: Bindings = {},
): ProjectionSelection[] {
  const selected = new Map<string, Set<string>>()
  const add = (table: string, fields: readonly string[]) => {
    const held = selected.get(table) ?? new Set<string>()
    for (const name of fields) held.add(name)
    selected.set(table, held)
  }
  const drawing = definition.drawing
  if (kind === 'network') {
    for (const vertex of drawing.vertices)
      add(vertex.table, [...vertex.position, ...(vertex.label ? [vertex.label] : [])])
    for (const edge of drawing.edges)
      add(edge.table, [...(edge.ends ?? []), ...(edge.bends ? [edge.bends] : [])])
    for (const binding of Object.values(bindings))
      if (fieldDefinition(definition, binding.table, binding.field)?.kind !== 'sampled')
        add(binding.table, [binding.field])
  } else {
    for (const block of drawing.blocks)
      add(block.table, [
        ...block.position,
        ...(block.label ? [block.label] : []),
        ...block.ports.map(([name]) => name),
      ])
    for (const net of drawing.nets) add(net, [])
  }
  return [...selected].map(([table, fields]) => ({ table, fields: [...fields].sort() }))
}
