import {
  type ColormapName,
  type Data,
  type Expr,
  field,
  type Fit,
  type Gestures,
  type Id,
  type Mark,
  type Scene,
  type Source,
  type TableInput,
  type Theme,
} from 'latkit'

import { type Bindings, type Channel, CHANNELS } from '../shared/bindings.js'
import type { ProjectionSelection, RecordedField } from '../shared/data.js'
import { type CaseDefinition, type Drawing, fieldDefinition } from '../shared/document.js'
import type { Plot, Results } from '../shared/messages.js'
import type { SettingsReader } from '../shared/preferences.js'

/** Background geography does not determine the extent of the case being inspected. */
export function caseFit(data: Data, drawing: Drawing): Fit {
  const tables = [...drawing.vertices, ...drawing.edges].map((item) => item.table)
  return { tables: [...new Set(tables)].map((table) => data.table(table)) }
}

export interface Binding {
  readonly table: string
  readonly field: string
  /** The marks it styles, and which of their options, as its channel in CHANNELS says. */
  readonly placement: 'vertex' | 'edge'
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

/** The distance the stress layout keeps between linked vertices, in plane units: latkit's own
 *  default, named so a case's span on a plane is known. */
export const GAP = 40

/** Each revision of a case's data is a Data of its own, so a span is measured once per revision. */
const spans = new WeakMap<Data, number>()

/** How far across a case's vertices lie, in the units its space places them in. On the earth: the
 *  diagonal of the box their positions fill, in degrees of arc, as elevations are. On a plane: the
 *  most links between two of them times the gap the stress layout keeps between linked vertices,
 *  since it draws graph distances as distances. */
export function caseSpan(data: Data, drawing: Drawing): number {
  let span = spans.get(data)
  if (span === undefined) {
    const held = new Set(data.describe().tables.map((table) => table.name))
    span = drawing.geographic
      ? diagonal(data, drawing, held)
      : GAP * linksAcross(data, drawing, held)
    spans.set(data, span)
  }
  return span
}

function diagonal(data: Data, drawing: Drawing, held: ReadonlySet<string>): number {
  let [west, east, south, north] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const { table, position } of drawing.vertices) {
    if (!held.has(table)) continue
    const { fields } = data.query({
      of: table,
      select: { x: field(position[0]), y: field(position[1]) },
    })
    const [xs, ys] = [fields.x as Float64Array, fields.y as Float64Array]
    for (let row = 0; row < xs.length; row++) {
      const [x, y] = [xs[row]!, ys[row]!]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < west) west = x
      if (x > east) east = x
      if (y < south) south = y
      if (y > north) north = y
    }
  }
  if (!(east >= west)) return 0
  // A degree of longitude is a degree of arc times the cosine of the latitude.
  const across = (east - west) * Math.cos((((north + south) / 2) * Math.PI) / 180)
  return Math.hypot(across, north - south)
}

function linksAcross(data: Data, drawing: Drawing, held: ReadonlySet<string>): number {
  // Every vertex by its place, table by table.
  const places = new Map<string, Map<Id, number>>()
  let count = 0
  for (const { table } of drawing.vertices) {
    if (!held.has(table) || places.has(table)) continue
    const place = new Map<Id, number>()
    for (const id of data.query({ of: table, select: {} }).ids) place.set(id, count++)
    places.set(table, place)
  }
  // Every link between two places, both ways.
  const from: number[] = []
  const to: number[] = []
  for (const { table, ends } of drawing.edges) {
    if (!ends || !held.has(table)) continue
    const { fields } = data.query({ of: table, select: { a: field(ends[0]), b: field(ends[1]) } })
    const [a, b] = [fields.a, fields.b] as { reference: string; ids: (Id | null)[] }[]
    const [first, second] = [places.get(a!.reference), places.get(b!.reference)]
    if (!first || !second) continue
    for (let row = 0; row < a!.ids.length; row++) {
      const [one, other] = [a!.ids[row], b!.ids[row]]
      const p = one === null || one === undefined ? undefined : first.get(one)
      const q = other === null || other === undefined ? undefined : second.get(other)
      if (p === undefined || q === undefined || p === q) continue
      from.push(p, q)
      to.push(q, p)
    }
  }
  // Each place's links in one array, as offsets into it.
  const offsets = new Int32Array(count + 1)
  for (const p of from) offsets[p + 1]!++
  for (let p = 0; p < count; p++) offsets[p + 1]! += offsets[p]!
  const linked = new Int32Array(from.length)
  const filled = offsets.slice(0, count)
  for (let i = 0; i < from.length; i++) linked[filled[from[i]!]!++] = to[i]!
  const links = new Int32Array(count).fill(-1)
  const queue = new Int32Array(count)
  /** Breadth first from `start`: how many places it reaches, the farthest last in `queue`. */
  const sweep = (start: number): number => {
    let reached = 1
    queue[0] = start
    links[start] = 0
    for (let at = 0; at < reached; at++) {
      const place = queue[at]!
      for (let i = offsets[place]!; i < offsets[place + 1]!; i++) {
        const next = linked[i]!
        if (links[next] !== -1) continue
        links[next] = links[place]! + 1
        queue[reached++] = next
      }
    }
    return reached
  }
  const forget = (reached: number) => {
    for (let at = 0; at < reached; at++) links[queue[at]!] = -1
  }
  // In each island, the place farthest from any, then the farthest from that: the most links
  // between two of its places, or close to it.
  const seen = new Uint8Array(count)
  let most = 0
  for (let start = 0; start < count; start++) {
    if (seen[start]) continue
    let reached = sweep(start)
    for (let at = 0; at < reached; at++) seen[queue[at]!] = 1
    const far = queue[reached - 1]!
    forget(reached)
    reached = sweep(far)
    most = Math.max(most, links[queue[reached - 1]!]!)
    forget(reached)
  }
  return Math.max(1, most)
}

/** What each channel's mapped values span; a height spans a share of the case's span. */
const RANGES: Record<'radius' | 'elevation' | 'width', [low: number, high: number]> = {
  radius: [0.5, 2.5],
  elevation: [0, 1],
  width: [0.5, 4],
}

function mapped(binding: Binding, map: ColormapName, sizes: NetworkSizes, height: number): Expr {
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
  placement: Binding['placement'],
  sizes: NetworkSizes,
  height: number,
): Record<string, Expr> {
  return Object.fromEntries(
    bindings
      .filter((binding) => binding.table === table && binding.placement === placement)
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
    const { option: channel, placement } = CHANNELS[key as Channel]
    const recorded = outputs.find(
      (output) => output.table === binding.table && output.field === binding.field,
    )
    const source = sampled(binding.table, binding.field)
    if (fieldDefinition(definition, binding.table, binding.field)?.kind === 'sampled' && !source)
      return []
    return [
      {
        ...binding,
        placement,
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
}

/** The Network of `data`, as the view and every export draws it. */
export function sceneOf(
  data: Data,
  definition: CaseDefinition,
  settings: SettingsReader,
  theme: Theme,
  { bindings = {}, results, sampled = () => undefined, background = [] }: SceneExtras,
): Scene {
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

/** What the wheel does in a view, as its Wheel behavior setting says. Every other input keeps
 *  latkit's own: a drag pans, Shift or the right button turns, two fingers pinch to zoom and slide
 *  to pan. A trackpad scrolls to pan, and its pinch, which reaches a page as the wheel with
 *  Control held, zooms. */
const WHEEL: Record<'wheel' | 'trackpad' | 'modifier' | 'off', Gestures> = {
  wheel: {},
  trackpad: { wheel: 'pan', 'control+wheel': 'zoom', 'meta+wheel': 'zoom' },
  modifier: { wheel: 'none', 'control+wheel': 'zoom', 'meta+wheel': 'zoom' },
  off: { wheel: 'none', pinch: 'none' },
}

/** How a view of `kind` answers its inputs: the wheel as its setting says, then `gestures`. */
function controls(settings: SettingsReader, kind: 'network' | 'monitor', gestures: Gestures = {}) {
  return {
    keyboard: true,
    gestures: { ...WHEEL[settings.get(`${kind}.zoom`)], ...gestures },
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
  // The highest mapped value raises a vertex a share of the case's span, whatever the space's
  // units and however large the case: its relief reads alike on every case.
  const height = bindings.some((binding) => binding.channel === 'elevation')
    ? settings.get('network.height') * caseSpan(data, drawing)
    : 0
  const map = settings.get('network.colormap')
  const edges = drawing.edges.map((edge): Mark => ({
    edges: [data.name, edge.table],
    name: edge.table,
    ...(edge.ends ? { ends: edge.ends } : {}),
    ...(edge.bends ? { bends: edge.bends } : {}),
    width: sizes.width,
    ...channels(edge.table, bindings, map, 'edge', sizes, height),
  }))
  const vertices = drawing.vertices.map((vertex): Mark => ({
    vertices: [data.name, vertex.table],
    name: vertex.table,
    position: [field(vertex.position[0]), field(vertex.position[1])],
    label: settings.get('network.labels') && vertex.label ? field(vertex.label) : null,
    radius: sizes.radius,
    ...channels(vertex.table, bindings, map, 'vertex', sizes, height),
  }))
  return {
    space: drawing.geographic
      ? {
          earth: {
            projection: settings.get('network.projection'),
            daylight: settings.get('network.map.daylight') ? Date.now() / 1000 : null,
          },
        }
      : 'plane',
    layout: { stress: { gap: GAP } },
    theme,
    ease: settings.get('network.ease'),
    controls: { ...controls(settings, 'network'), cycle: true },
    // The map under everything, then branches, then buses. Where depth varies, the nearest
    // opaque pixel shows, and a mark whose rows a mapped height raises draws them lowest first:
    // farthest first wherever they overlap, from any camera.
    marks: [...background, ...edges, ...vertices],
  }
}

/** A plot of `plot`'s field over the times its camera shows, each trace in its own color by its
 *  place among them (`series`). Its axes carry ticks alone: every plot shares the time axis, whose
 *  last tick says it is seconds, and the Monitor names each plot in its lane. A picture has no
 *  lanes, so it passes `name` for the plot to name itself on its value axis. */
export function plotScene(
  source: Source,
  plot: Plot,
  settings: SettingsReader,
  theme: Theme,
  name?: string,
): Scene {
  return {
    space: { plot: { x: { unit: ' s' }, y: { label: name ?? null } } },
    theme,
    ease: 0,
    // Shift and a drag frames a span of time, which becomes the window the Monitor shows.
    controls: controls(settings, 'monitor', { 'shift+primary': 'zoomBox' }),
    marks: [
      {
        lines: [source.name, plot.from],
        trace: plot.field,
        name: plot.field,
        color: field('series').colormap(settings.get('monitor.colormap')),
        width: settings.get('monitor.lineWidth'),
        interpolation: settings.get('monitor.interpolation') === 'step' ? 'stepAfter' : 'linear',
      },
    ],
  }
}

/** Only fields the Network's marks need; sampled fields live in their own bounded sources. */
export function sceneFields(
  definition: CaseDefinition,
  bindings: Bindings = {},
): ProjectionSelection[] {
  const selected = new Map<string, Set<string>>()
  const add = (table: string, fields: readonly string[]) => {
    const held = selected.get(table) ?? new Set<string>()
    for (const name of fields) held.add(name)
    selected.set(table, held)
  }
  const drawing = definition.drawing
  for (const vertex of drawing.vertices)
    add(vertex.table, [...vertex.position, ...(vertex.label ? [vertex.label] : [])])
  for (const edge of drawing.edges)
    add(edge.table, [...(edge.ends ?? []), ...(edge.bends ? [edge.bends] : [])])
  for (const binding of Object.values(bindings))
    if (fieldDefinition(definition, binding.table, binding.field)?.kind !== 'sampled')
      add(binding.table, [binding.field])
  return [...selected].map(([table, fields]) => ({ table, fields: [...fields].sort() }))
}
