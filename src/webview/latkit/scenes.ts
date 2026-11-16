/** latkit scenes for the Network and the Monitor's plots. */

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

import type { FieldSelection, RecordedField, ValueRange } from '../../shared/data.js'
import {
  type CaseDefinition,
  type Drawing,
  type Field,
  fieldDefinition,
} from '../../shared/document.js'
import { type Channel, CHANNELS, type Mappings } from '../../shared/mappings.js'
import type { Plot, Results } from '../../shared/messages.js'
import type { SettingsReader } from '../../shared/settings.js'
import { type Background, NO_MAP } from './maps.js'
import { caseSpan, GAP } from './span.js'

/** Fits the case's own tables, so a background map does not widen the fit. */
export function caseFit(data: Data, drawing: Drawing): Fit {
  const tables = [...drawing.vertices, ...drawing.edges].map((item) => item.table)
  return { tables: [...new Set(tables)].map((table) => data.table(table)) }
}

/** A mapped field as a mark option: which option, where its values are read, and their range. */
interface Style extends Field {
  readonly placement: 'vertex' | 'edge'
  readonly option: 'color' | 'radius' | 'elevation' | 'width' | 'dash'
  readonly source?: TableInput
  readonly range?: ValueRange
}

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

/** CSS pixel sizes; the radius is at least the edge width, so a vertex shows past its edges. */
function networkSizes(settings: SettingsReader): NetworkSizes {
  const width = settings.get('network.edgeWidth')
  return { width, radius: Math.max(width, settings.get('network.vertexRadius')) }
}

/** Each channel's output range: a size from 1 to 3 times the mark's own, so mapping only enlarges
 *  a mark; an elevation as a share of the case's span. */
const RANGES: Record<'radius' | 'elevation' | 'width', [low: number, high: number]> = {
  radius: [1, 3],
  elevation: [0, 1],
  width: [1, 3],
}

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

/** `mappings` as styles; a sampled field is left out until `sampled` has its frames. */
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

type Ground = Pick<Background, 'marks' | 'attribution'>

/** The current time in epoch seconds when `enabled`, else null. Read once per view, so its
 *  scenes match. */
export const daylightOf = (enabled: boolean): number | null => (enabled ? Date.now() / 1000 : null)

interface SceneExtras {
  readonly mappings?: Mappings
  readonly results?: Results
  readonly sampled?: (table: string, field: string) => Source | undefined
  readonly background?: Ground
  /** The sun's time in epoch seconds, or null for even lighting. */
  readonly daylight?: number | null
}

export function sceneOf(
  data: Data,
  definition: CaseDefinition,
  settings: SettingsReader,
  theme: Theme,
  { mappings = {}, results, sampled = () => undefined, background, daylight }: SceneExtras,
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
    daylight,
  )
}

/** Gestures for each Wheel behavior setting; other inputs keep latkit's defaults. A trackpad pinch
 *  arrives as the wheel with Control held. */
const WHEEL: Record<'wheel' | 'trackpad' | 'modifier' | 'off', Gestures> = {
  wheel: {},
  trackpad: { wheel: 'pan', 'control+wheel': 'zoom', 'meta+wheel': 'zoom' },
  modifier: { wheel: 'none', 'control+wheel': 'zoom', 'meta+wheel': 'zoom' },
  off: { wheel: 'none', pinch: 'none' },
}

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
  background: Ground = NO_MAP,
  daylight: number | null = null,
): Scene {
  const sizes = networkSizes(settings)
  // Elevation scales with the case's span, so relief looks the same in any space and at any size.
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
      ? { earth: { projection: settings.get('network.projection'), daylight } }
      : 'plane',
    layout: { stress: { gap: GAP } },
    theme,
    ease: settings.get('network.transitionDuration'),
    controls: { ...controls(settings, 'network'), cycle: true },
    // Map, then branches, then buses. latkit draws elevated rows lowest first, so overlaps
    // resolve correctly from any camera.
    marks: [...background.marks, ...edges, ...vertices],
    // The map's attribution, also in exports; a subtitle because title text is large.
    title: background.attribution
      ? { text: '', subtitle: background.attribution, place: 'bottom-right' }
      : null,
  }
}

/** A plot of `plot`'s traces, colored by `series`. The axes show only ticks; images have no lane
 *  header, so they pass `name` to label the value axis. */
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
    // Shift and drag zooms to a span of time, which becomes the Monitor's window.
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

/** The case fields the Network's marks read; sampled fields come from their own sources. */
export function sceneFields(definition: CaseDefinition, mappings: Mappings = {}): FieldSelection[] {
  const selected = new Map<string, Set<string>>()
  const add = (table: string, fields: readonly string[]) => {
    const names = selected.get(table) ?? new Set<string>()
    for (const name of fields) names.add(name)
    selected.set(table, names)
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
