/** The display settings of Network and Monitor, each defined once; VS Code owns the theme,
 *  its contrast and its motion. `pnpm settings` writes them into package.json for VS Code Settings. */

import { type ColormapName, colormaps } from 'latkit'

/** One setting: the default a reset restores and the values it takes. Null leaves a color to the
 *  theme. */
type Setting = {
  readonly id: string
  readonly label: string
  /** A one-line note, only where it says what the label does not. */
  readonly description?: string
} & (
  | { readonly kind: 'boolean'; readonly default: boolean }
  | {
      readonly kind: 'choice'
      readonly default: string | number
      readonly options: readonly { readonly value: string | number; readonly label: string }[]
    }
  | {
      readonly kind: 'number'
      readonly default: number
      readonly min: number
      readonly max: number
      /** A step of 1 takes integers only. */
      readonly step: number
    }
  | { readonly kind: 'color'; readonly default: string | null }
  | { readonly kind: 'text'; readonly default: string }
)

/** A choice's options as value and label, in the order VS Code lists them. */
type Options<V> = readonly (readonly [value: V, label: string])[]

// A row reads: id, label, default, then the range or options of its kind, then the description.
const bool = <const I extends string>(id: I, label: string, value: boolean, description?: string) =>
  ({ kind: 'boolean', id, label, description, default: value }) as const

const num = <const I extends string>(
  id: I,
  label: string,
  value: number,
  [min, max, step]: readonly [min: number, max: number, step: number],
  description?: string,
) => ({ kind: 'number', id, label, description, default: value, min, max, step }) as const

const choice = <const I extends string, const V extends string | number>(
  id: I,
  label: string,
  value: NoInfer<V>,
  options: Options<V>,
  description?: string,
) =>
  ({
    kind: 'choice',
    id,
    label,
    description,
    default: value,
    options: options.map((option) => ({ value: option[0], label: option[1] })),
  }) as const

/** A color is `#rrggbb` or `#rrggbbaa`. */
const color = <const I extends string>(
  id: I,
  label: string,
  value: string | null,
  description?: string,
) => ({ kind: 'color', id, label, description, default: value }) as const

const text = <const I extends string>(id: I, label: string, value: string, description?: string) =>
  ({ kind: 'text', id, label, description, default: value }) as const

interface Group {
  readonly label: string
  readonly settings: readonly Setting[]
}

/** Settings under a heading of their category; an empty label runs them straight on. */
const group = <const S extends readonly Setting[]>(label: string, settings: S) => ({
  label,
  settings,
})

const category = <const G extends readonly Group[]>(id: string, label: string, groups: G) => ({
  id,
  label,
  groups,
})

/** latkit's colormaps that map a number, as it names and labels them: all but the categorical. */
const COLORMAPS: Options<ColormapName> = colormaps()
  .filter((map) => map.kind !== 'categorical')
  .map((map) => [map.name, map.label] as const)
/** latkit's categorical colormaps, which give each trace of a plot its own color. */
const TRACE_COLORMAPS: Options<ColormapName> = colormaps()
  .filter((map) => map.kind === 'categorical')
  .map((map) => [map.name, map.label] as const)
const ZOOM = [
  ['wheel', 'Wheel'],
  ['modifier', 'Modifier + wheel'],
  ['off', 'Off'],
] as const
/** The Network's wheel can also pan, as a trackpad scrolls. The Monitor's wheel scrolls its plots. */
const NETWORK_ZOOM = [['wheel', 'Wheel'], ['trackpad', 'Trackpad'], ...ZOOM.slice(1)] as const
const TRACKPAD = 'Trackpad scrolls to pan and pinches to zoom.'
const MOTION = [
  ['system', 'System'],
  ['full', 'Full'],
  ['reduced', 'Reduced'],
] as const
/** The tilt the Network's Tilt button sets, and a height mapped on a flat Network takes. */
export const TILTED = 45
/** The narrowest an edge draws, in CSS pixels. latkit writes depth only where a line covers whole
 *  pixels, so a thinner line is a faint sliver that hides nothing behind it, and where many cross,
 *  the most numerous color shows whichever is nearest. */
export const EDGE_WIDTH = 2
export const SETTINGS = [
  category('network', 'Network', [
    group('View', [
      choice('network.projection', 'Projection', 'mercator', [
        ['mercator', 'Mercator'],
        ['globe', 'Globe'],
      ]),
      num('network.tilt', 'Tilt', 0, [0, 75, 1]),
      num('network.orbit', 'Orbit', 0, [-90, 90, 1], 'Degrees per second.'),
      bool('network.labels', 'Labels', false),
      num(
        'network.vertexRadius',
        'Vertex radius',
        2.5,
        [EDGE_WIDTH, 12, 0.25],
        'Radius in CSS pixels, never under the edge width, so a vertex shows past the edges that meet it. Size mappings start from this radius.',
      ),
      num(
        'network.edgeWidth',
        'Edge width',
        EDGE_WIDTH,
        [EDGE_WIDTH, 8, 0.25],
        `Width in CSS pixels, at least ${EDGE_WIDTH}, as a thinner line can't hide what is behind it. Width mappings start from this width.`,
      ),
      choice('network.colormap', 'Colormap', 'viridis', COLORMAPS),
      num('network.ease', 'Transition duration', 0.3, [0, 2, 0.05], 'Seconds.'),
      num(
        'network.height',
        'Height',
        0.2,
        [0.01, 1, 0.01],
        'How high the highest mapped value raises a vertex: a share of the distance across the case.',
      ),
    ]),
    group('Interaction', [
      choice('network.zoom', 'Wheel behavior', 'wheel', NETWORK_ZOOM, TRACKPAD),
      choice('network.motion', 'Motion', 'system', MOTION),
      num('network.pickRadius', 'Picking distance', 8, [0, 32, 1]),
    ]),
    group('Map', [
      choice('network.map.source', 'Map', 'borders', [
        ['borders', 'Bundled borders'],
        ['streets', 'Street map'],
        ['none', 'None'],
      ]),
      text('network.map.tilesUrl', 'Tiles URL', 'https://tiles.openfreemap.org/planet'),
      text(
        'network.map.attribution',
        'Attribution',
        '\u00a9 OpenStreetMap contributors \u00b7 OpenFreeMap',
      ),
      bool('network.map.daylight', 'Daylight', false),
      color('network.map.ground', 'Ground color', null),
      num('network.map.night', 'Night brightness', 0.3, [0, 1, 0.01]),
    ]),
  ]),
  category('monitor', 'Monitor', [
    group('Lines', [
      choice('monitor.interpolation', 'Interpolation', 'linear', [
        ['linear', 'Linear'],
        ['step', 'Step'],
      ]),
      num('monitor.lineWidth', 'Line width', 1, [0.25, 8, 0.25]),
      choice('monitor.colormap', 'Colormap', 'tab10', TRACE_COLORMAPS),
    ]),
    group('Interaction', [
      choice('monitor.zoom', 'Wheel behavior', 'wheel', ZOOM),
      choice('monitor.motion', 'Motion', 'system', MOTION),
      num('monitor.pickRadius', 'Picking distance', 8, [0, 32, 1]),
    ]),
  ]),
] as const

type Definition = (typeof SETTINGS)[number]['groups'][number]['settings'][number]
/** A setting's value takes its default's type. */
type ValueOf<D extends Definition> = D['default']

export type SettingsValues = { [D in Definition as D['id']]: ValueOf<D> }
type SettingKey = keyof SettingsValues
type SettingsDocument = Partial<SettingsValues>
export interface SettingsReader {
  get<K extends SettingKey>(key: K): SettingsValues[K]
}

export const definitions: readonly Setting[] = SETTINGS.flatMap((category) =>
  category.groups.flatMap<Setting>((group) => group.settings),
)
const byId = new Map(definitions.map((setting) => [setting.id, setting]))
export const defaults = Object.freeze(
  Object.fromEntries(definitions.map((setting) => [setting.id, setting.default])),
) as Readonly<SettingsValues>

/** Validate a whole change before committing any of it. */
export function validateSettings(input: unknown): SettingsDocument {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Settings must be a JSON object.')
  const entries = Object.entries(input)
  for (const [key, value] of entries) {
    const setting = byId.get(key)
    if (!setting) throw new Error('Unknown setting: ' + key + '.')
    let valid = false
    switch (setting.kind) {
      case 'boolean':
        valid = typeof value === 'boolean'
        break
      case 'choice':
        valid = setting.options.some((option) => option.value === value)
        break
      case 'number':
        valid =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= setting.min &&
          value <= setting.max &&
          (setting.step !== 1 || Number.isInteger(value))
        break
      case 'color':
        valid =
          value === null ||
          (typeof value === 'string' && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value))
        break
      case 'text':
        valid = typeof value === 'string'
        break
    }
    if (!valid) throw new Error('Invalid value for ' + key + '.')
  }
  return Object.fromEntries(entries) as SettingsDocument
}

const readers = new WeakMap<SettingsDocument, SettingsReader>()
const unset: SettingsReader = { get: (key) => defaults[key] }

/** The settings in `values`, else their defaults. Each object has one reader, so what is derived
 *  from a reader stays equal while its settings do. */
export function reader(values?: SettingsDocument): SettingsReader {
  if (!values) return unset
  let found = readers.get(values)
  if (!found)
    readers.set(values, (found = { get: (key) => (key in values ? values[key]! : defaults[key]) }))
  return found
}
