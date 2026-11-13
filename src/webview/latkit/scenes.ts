/** What the views draw, as latkit scenes: the Network of a case, and a plot of a recorded field. */

import {
  type ColormapName,
  type Data,
  type Expr,
  field,
  type Fit,
  type Gestures,
  type Mark,
  type Scene,
  type Source,
  type TableInput,
  type Theme,
} from 'latkit'

import type { ProjectionSelection, RecordedField, ValueRange } from '../../shared/data.js'
import {
  type CaseDefinition,
  type Drawing,
  type Field,
  fieldDefinition,
} from '../../shared/document.js'
import { type Channel, CHANNELS, type Mappings } from '../../shared/mappings.js'
import type { Plot, Results } from '../../shared/messages.js'
import type { SettingsReader } from '../../shared/settings.js'
import { caseSpan, GAP } from './span.js'

/** Background geography does not determine the extent of the case being inspected. */
export function caseFit(data: Data, drawing: Drawing): Fit {
  const tables = [...drawing.vertices, ...drawing.edges].map((item) => item.table)
  return { tables: [...new Set(tables)].map((table) => data.table(table)) }
}

/** A mapped field as the marks of its type draw it: the marks it styles and which of their options,
 *  as its channel in CHANNELS says, where its values are read, and the values the option spans. */
export interface Style extends Field {
  readonly placement: 'vertex' | 'edge'
  readonly option: 'color' | 'radius' | 'elevation' | 'width' | 'dash'
  readonly source?: TableInput
  readonly range?: ValueRange
}

/** The sampled fields the mappings read from `results`, each once, as `[table, field]`. */
export function sampledFields(
  definition: CaseDefinition,
  mappings: Mappings = {},
  results?: Results,
): Array<readonly [table: string, field: string]> {
  const fields = new Map<string, readonly [string, string]>()
  if (results)
    for (const { table, field } of Object.values(mappings))
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

/** The Network's sizes in CSS pixels, as the settings give them on every case: a vertex never
 *  narrower than twice its edges, so it shows past the edges that meet it. */
function networkSizes(settings: SettingsReader): NetworkSizes {
  const width = settings.get('network.edgeWidth')
  return { width, radius: Math.max(width, settings.get('network.vertexRadius')) }
}

/** What each channel's mapped values span: a size from the mark's own to three times it, so a
 *  mapping only enlarges a mark, which draws no smaller than it does unmapped; a height, a share of
 *  the case's span. */
const RANGES: Record<'radius' | 'elevation' | 'width', [low: number, high: number]> = {
  radius: [1, 3],
  elevation: [0, 1],
  width: [1, 3],
}

/** What a mark's option reads of the field `style` maps. */
function optionOf(style: Style, map: ColormapName, sizes: NetworkSizes, height: number): Expr {
  let value = field(style.field)
  if (style.source) value = value.from(style.source)
  const { option } = style
  if (option === 'dash') return value.gt(0)
  const output = option === 'color' ? value.colormap(map) : value.scale(...RANGES[option])
  const ranged = style.range ? output.domain(style.range[0], style.range[1]) : output
  if (option === 'color') return ranged
  if (option === 'elevation') return ranged.mul(height)
  // Missing sampled rows retain the ordinary case size instead of a theme-sized fallback.
  const size = sizes[option]
  return ranged.mul(size).fallback(size)
}

/** The options the marks of `table` drawn as `placement` take from `styles`. */
function options(
  table: string,
  styles: readonly Style[],
  map: ColormapName,
  placement: Style['placement'],
  sizes: NetworkSizes,
  height: number,
): Record<string, Expr> {
  return Object.fromEntries(
    styles
      .filter((style) => style.table === table && style.placement === placement)
      .map((style) => [style.option, optionOf(style, map, sizes, height)]),
  )
}

/** `mappings` as the marks draw them: each over the values it was given, else those the results
 *  hold of it. A sampled field draws once `sampled` has its frames. */
export function stylesOf(
  definition: CaseDefinition,
  mappings: Mappings,
  outputs: readonly RecordedField[],
  sampled: (table: string, field: string) => Source | undefined,
): Style[] {
  return Object.entries(mappings).flatMap(([channel, mapping]) => {
    const { option, placement } = CHANNELS[channel as Channel]
    const recorded = outputs.find(
      (output) => output.table === mapping.table && output.field === mapping.field,
    )
    const source = sampled(mapping.table, mapping.field)
    if (fieldDefinition(definition, mapping.table, mapping.field)?.kind === 'sampled' && !source)
      return []
    const range = mapping.range ?? recorded?.domain
    return [
      {
        table: mapping.table,
        field: mapping.field,
        placement,
        option,
        ...(source && { source: [source.name, mapping.table] as const }),
        ...(range && { range }),
      },
    ]
  })
}

/** What a scene of a case draws besides the case: its mappings' results and a map. */
interface SceneExtras {
  readonly mappings?: Mappings
  readonly results?: Results
  /** The source of a mapped sampled field, once its frames are held. */
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
  { mappings = {}, results, sampled = () => undefined, background = [] }: SceneExtras,
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
    stylesOf(definition, mappings, outputs, sampled),
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
    gestures: { ...WHEEL[settings.get(`${kind}.wheelBehavior`)], ...gestures },
    motion:
      settings.get(`${kind}.motion`) === 'system' &&
      typeof document !== 'undefined' &&
      document.body.classList.contains('vscode-reduce-motion')
        ? ('reduced' as const)
        : settings.get(`${kind}.motion`),
    pickRadius: settings.get(`${kind}.pickingDistance`),
  }
}

export function networkScene(
  data: Data,
  drawing: Drawing,
  settings: SettingsReader,
  theme: Theme,
  styles: readonly Style[],
  background: readonly Mark[] = [],
): Scene {
  const sizes = networkSizes(settings)
  // The highest mapped value raises a vertex a share of the case's span, whatever the space's
  // units and however large the case: its relief reads alike on every case.
  const height = styles.some((style) => style.option === 'elevation')
    ? settings.get('network.height') * caseSpan(data, drawing)
    : 0
  const map = settings.get('network.colormap')
  const edges = drawing.edges.map((edge): Mark => ({
    edges: [data.name, edge.table],
    name: edge.table,
    ...(edge.ends ? { ends: edge.ends } : {}),
    ...(edge.bends ? { bends: edge.bends } : {}),
    width: sizes.width,
    ...options(edge.table, styles, map, 'edge', sizes, height),
  }))
  const vertices = drawing.vertices.map((vertex): Mark => ({
    vertices: [data.name, vertex.table],
    name: vertex.table,
    position: [field(vertex.position[0]), field(vertex.position[1])],
    label: settings.get('network.labels') && vertex.label ? field(vertex.label) : null,
    radius: sizes.radius,
    ...options(vertex.table, styles, map, 'vertex', sizes, height),
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
    ease: settings.get('network.transitionDuration'),
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
        lines: [source.name, plot.table],
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
  mappings: Mappings = {},
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
  for (const mapping of Object.values(mappings))
    if (fieldDefinition(definition, mapping.table, mapping.field)?.kind !== 'sampled')
      add(mapping.table, [mapping.field])
  return [...selected].map(([table, fields]) => ({ table, fields: [...fields].sort() }))
}
