import {
  type ColormapName,
  type Data,
  type Expr,
  field,
  type Fit,
  type Mark,
  meters,
  type Scene,
  type Source,
  type TableInput,
  type Theme,
} from 'latkit'

import { type Bindings, type Channel, CHANNELS } from '../shared/bindings.js'
import type { ProjectionSelection, RecordedField } from '../shared/data.js'
import { type CaseDefinition, type Drawing, fieldDefinition } from '../shared/document.js'
import type { Results } from '../shared/messages.js'
import type { SettingsReader } from '../shared/preferences.js'

/** Background geography does not determine the extent of the case being inspected. */
export function caseFit(data: Data, drawing: Drawing, kind: 'network' | 'diagram'): Fit {
  const tables =
    kind === 'network'
      ? [...drawing.vertices, ...drawing.edges].map((item) => item.table)
      : [...drawing.blocks.map((item) => item.table), ...drawing.nets]
  return { tables: [...new Set(tables)].map((table) => data.table(table)) }
}

export interface Binding {
  readonly table: string
  readonly field: string
  readonly channel: 'color' | 'radius' | 'elevation' | 'width' | 'dash'
  readonly source?: TableInput
  readonly domain?: readonly [number, number]
}

/** The sampled fields the bindings read from `results`, each once, as `[table, field]`. */
export function sampledFields(
  definition: CaseDefinition,
  bindings: Bindings = {},
  results?: Results,
): Array<readonly [table: string, field: string]> {
  const fields = new Map<string, readonly [string, string]>()
  if (results)
    for (const { table, field } of Object.values(bindings))
      if (
        fieldDefinition(definition, table, field)?.kind === 'sampled' &&
        results.outputs.some((output) => output.table === table && output.field === field)
      )
        fields.set(JSON.stringify([table, field]), [table, field])
  return [...fields.values()]
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

/** What each channel's mapped values span; a height spans the setting's meters on the earth. */
const RANGES: Record<'radius' | 'elevation' | 'width', [low: number, high: number]> = {
  radius: [0.5, 2.5],
  elevation: [0, 1],
  width: [0.5, 4],
}

function mapped(
  binding: Binding,
  map: ColormapName,
  sizes: NetworkSizes,
  height: number | Expr,
): Expr {
  let value = field(binding.field)
  if (binding.source) value = value.from(binding.source)
  const { channel } = binding
  if (channel === 'dash') return value.gt(0)
  const output = channel === 'color' ? value.colormap(map) : value.scale(...RANGES[channel])
  const ranged = binding.domain ? output.domain(binding.domain[0], binding.domain[1]) : output
  if (channel === 'color') return ranged
  if (channel === 'elevation') return ranged.mul(height)
  // Missing sampled rows retain the ordinary case size instead of a theme-sized fallback.
  const size = sizes[channel]
  return ranged.mul(size).fallback(size)
}

function channels(
  table: string,
  bindings: readonly Binding[],
  map: ColormapName,
  vertex: boolean,
  sizes: NetworkSizes,
  height: number | Expr,
): Record<string, Expr> {
  const allowed = vertex ? ['color', 'radius', 'elevation'] : ['color', 'width', 'dash']
  return Object.fromEntries(
    bindings
      .filter((binding) => binding.table === table && allowed.includes(binding.channel))
      .map((binding) => [binding.channel, mapped(binding, map, sizes, height)]),
  )
}

export function sceneBindings(
  definition: CaseDefinition,
  bindings: Bindings,
  outputs: readonly RecordedField[],
  sampled: (table: string, field: string) => Source | undefined,
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
      },
    ]
  })
}

/** What a scene of a case draws besides the case: its bindings' results and a map. */
export interface SceneExtras {
  readonly bindings?: Bindings
  readonly results?: Results
  /** The source of a binding's sampled field, once its frames are held. */
  readonly sampled?: (table: string, field: string) => Source | undefined
  /** Marks drawn under the case's own, such as a map's. */
  readonly background?: readonly Mark[]
  readonly editable?: boolean
}

/** The Network or Diagram of `data`, as every view and export draws it. */
export function sceneOf(
  kind: 'network' | 'diagram',
  data: Data,
  definition: CaseDefinition,
  settings: SettingsReader,
  theme: Theme,
  {
    bindings = {},
    results,
    sampled = () => undefined,
    background = [],
    editable = false,
  }: SceneExtras,
): Scene {
  if (kind === 'diagram') return diagramScene(data, definition.drawing, settings, theme, editable)
  const outputs =
    results?.outputs.map((output) => ({
      ...output,
      domain: results.domains?.[output.table]?.[output.field],
    })) ?? []
  return networkScene(
    data,
    definition.drawing,
    settings,
    theme,
    sceneBindings(definition, bindings, outputs, sampled),
    background,
  )
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
  const height = drawing.geographic ? meters(settings.get('network.heightMeters')) : 1
  const map = settings.get('network.colormap')
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
        ...channels(edge.table, bindings, map, false, sizes, height),
      })),
      ...drawing.vertices.map((vertex): Mark => ({
        vertices: [data.name, vertex.table],
        name: vertex.table,
        position: [field(vertex.position[0]), field(vertex.position[1])],
        label: settings.get('network.labels') && vertex.label ? field(vertex.label) : null,
        radius: sizes.radius,
        ...channels(vertex.table, bindings, map, true, sizes, height),
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
