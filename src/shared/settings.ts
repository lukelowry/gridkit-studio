/** The single definition of every Studio setting. `pnpm settings` writes them into package.json.
 *  Theme, contrast and motion preferences stay VS Code's. */

import { type ColormapName, colormaps } from 'latkit'

type Scope = 'resource' | 'machine-overridable' | 'window'

/** One setting definition. A null color follows the theme. Numbers are bounded only where latkit
 *  or the meaning of the value requires it. */
type Setting = { readonly scope: Scope; readonly description?: string } & (
  | { readonly kind: 'boolean'; readonly default: boolean }
  | {
      readonly kind: 'choice'
      readonly default: string | number
      readonly options: readonly { readonly value: string | number; readonly label: string }[]
    }
  | {
      readonly kind: 'number'
      readonly default: number
      readonly min?: number
      readonly max?: number
      readonly integer: boolean
    }
  | { readonly kind: 'color'; readonly default: string | null }
  | { readonly kind: 'text'; readonly default: string }
)

type Options<V> = readonly (readonly [value: V, label: string])[]

// Each helper takes the default, then the range or options, then the description.
const bool = (value: boolean, description?: string) =>
  ({ kind: 'boolean', scope: 'resource', default: value, description }) as const

const num = (
  value: number,
  [min, max]: readonly [min?: number, max?: number],
  description?: string,
) =>
  ({
    kind: 'number',
    scope: 'resource',
    default: value,
    min,
    max,
    integer: false,
    description,
  }) as const

const int = (
  value: number,
  [min, max]: readonly [min?: number, max?: number],
  description?: string,
) =>
  ({
    kind: 'number',
    scope: 'resource',
    default: value,
    min,
    max,
    integer: true,
    description,
  }) as const

const choice = <const V extends string | number>(
  value: NoInfer<V>,
  options: Options<V>,
  description?: string,
) =>
  ({
    kind: 'choice',
    scope: 'resource',
    default: value,
    options: options.map((option) => ({ value: option[0], label: option[1] })),
    description,
  }) as const

/** A color is `#rrggbb` or `#rrggbbaa`. */
const color = (value: string | null, description?: string) =>
  ({ kind: 'color', scope: 'resource', default: value, description }) as const

const text = (value: string, description?: string) =>
  ({ kind: 'text', scope: 'resource', default: value, description }) as const

/** Scopes a setting to the machine GridKit runs on, overridable per workspace. */
const machine = <S extends Setting>(
  setting: S,
): Omit<S, 'scope'> & { scope: 'machine-overridable' } => ({
  ...setting,
  scope: 'machine-overridable',
})

const windowed = <S extends Setting>(setting: S): Omit<S, 'scope'> & { scope: 'window' } => ({
  ...setting,
  scope: 'window',
})

const COLORMAPS: Options<ColormapName> = colormaps()
  .filter((map) => map.kind !== 'categorical')
  .map((map) => [map.name, map.label] as const)
/** latkit's categorical colormaps, which give each plot trace its own color. */
const TRACE_COLORMAPS: Options<ColormapName> = colormaps()
  .filter((map) => map.kind === 'categorical')
  .map((map) => [map.name, map.label] as const)
const WHEEL = [
  ['wheel', 'Wheel zooms'],
  ['modifier', 'Modifier + wheel zooms'],
  ['off', 'Off'],
] as const
/** The Network's wheel can also pan, like a trackpad. */
const NETWORK_WHEEL = [
  ['wheel', 'Wheel zooms'],
  ['trackpad', 'Scroll pans, pinch zooms'],
  ...WHEEL.slice(1),
] as const
const MOTION = [
  ['system', 'System'],
  ['full', 'Full'],
  ['reduced', 'Reduced'],
] as const
/** The tilt set by the Network's Tilt button, and when a height is mapped on a flat Network. */
export const TILTED = 45
/** The minimum edge width in CSS pixels. latkit writes depth only where a line covers whole pixels,
 *  so a thinner line hides nothing behind it, and where many cross the most common color wins
 *  regardless of depth. */
export const EDGE_WIDTH = 2
/** The settings by id in display order: GridKit's first, then each view's, prefixed by its name. */
export const SETTINGS = {
  gridkitPath: machine(
    text(
      '',
      'GridKit installation directory or executable. Leave empty to use the included solver. Relative paths start at the workspace folder.',
    ),
  ),
  gridkitProgram: machine(
    text(
      'DynamicSimulation',
      'Executable name to use when GridKit Path is an installation directory.',
    ),
  ),
  catalog: machine(
    text(
      '',
      'Path to a GridKit class catalog, for a GridKit build whose classes differ from the included one. Relative paths start at the first workspace folder. Read when the window opens.',
    ),
  ),
  resultCacheMiB: windowed(
    num(
      256,
      [0],
      'Memory, in MiB, for results no view shows, so they reopen at once. The least recently used are released first.',
    ),
  ),

  'network.projection': choice('mercator', [
    ['mercator', 'Mercator'],
    ['globe', 'Globe'],
  ]),
  // latkit's camera tilts at most 75° from straight down.
  'network.tilt': int(0, [0, 75], 'Degrees from straight down.'),
  'network.orbit': int(0, [], 'Degrees per second.'),
  'network.labels': bool(false, 'Show bus names.'),
  'network.vertexRadius': num(
    2.5,
    [EDGE_WIDTH],
    'Radius in CSS pixels, at least the edge width. Size mappings start from this radius.',
  ),
  'network.edgeWidth': num(
    EDGE_WIDTH,
    [EDGE_WIDTH],
    `Width in CSS pixels, at least ${EDGE_WIDTH}. Width mappings start from this width.`,
  ),
  'network.colormap': choice('viridis', COLORMAPS),
  'network.transitionDuration': num(0.3, [0], 'Seconds.'),
  'network.height': num(
    0.2,
    [0.01],
    "Height of the largest mapped value, as a fraction of the case's width.",
  ),
  'network.wheelBehavior': choice('wheel', NETWORK_WHEEL),
  'network.motion': choice('system', MOTION),
  'network.pickingDistance': int(8, [0], 'How near the pointer finds an element, in CSS pixels.'),
  'network.map.source': choice('borders', [
    ['borders', 'Included borders'],
    ['streets', 'Street map'],
    ['none', 'None'],
  ]),
  'network.map.tilesUrl': text(
    'https://tiles.openfreemap.org/planet',
    "The Street map's vector tiles: a PMTiles archive, a TileJSON document, or a {z}/{x}/{y} URL.",
  ),
  'network.map.attribution': text(
    '© OpenStreetMap contributors · OpenFreeMap',
    'The credit shown on the Street map.',
  ),
  'network.map.daylight': bool(false, "Shade the map by the sun's position now."),
  'network.map.groundColor': color(null, 'Leave empty to follow the color theme.'),
  'network.map.nightBrightness': num(0.3, [0, 1], 'Brightness of the night side, from 0 to 1.'),

  'monitor.interpolation': choice('linear', [
    ['linear', 'Linear'],
    ['step', 'Step'],
  ]),
  'monitor.lineWidth': num(1, [0.25], 'CSS pixels.'),
  'monitor.colormap': choice('tab10', TRACE_COLORMAPS),
  'monitor.wheelBehavior': choice('wheel', WHEEL),
  'monitor.motion': choice('system', MOTION),
  'monitor.pickingDistance': int(8, [0], 'How near the pointer finds a trace, in CSS pixels.'),
} as const satisfies Record<string, Setting>

type Definitions = typeof SETTINGS
export type Settings = { [K in keyof Definitions]: Definitions[K]['default'] }
/** The display settings the pages read, prefixed by their view's name. */
type ViewKey = Extract<keyof Settings, `${'network' | 'monitor'}.${string}`>
export type ViewSettings = Pick<Settings, ViewKey>
export interface SettingsReader {
  get<K extends ViewKey>(key: K): ViewSettings[K]
}

const VIEW_KEYS = (Object.keys(SETTINGS) as (keyof Settings)[]).filter(
  (id): id is ViewKey => id.startsWith('network.') || id.startsWith('monitor.'),
)
export const defaults = Object.freeze(
  Object.fromEntries(VIEW_KEYS.map((id) => [id, SETTINGS[id].default])),
) as Readonly<ViewSettings>

/** Validates `input` as view settings by kind and range. Throws on the first invalid entry, so a
 *  change is applied whole or not at all. */
export function validateSettings(input: unknown): Partial<ViewSettings> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Settings must be a JSON object.')
  const entries = Object.entries(input)
  for (const [key, value] of entries) {
    const setting: Setting | undefined = (VIEW_KEYS as string[]).includes(key)
      ? SETTINGS[key as ViewKey]
      : undefined
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
          (setting.min === undefined || value >= setting.min) &&
          (setting.max === undefined || value <= setting.max) &&
          (!setting.integer || Number.isInteger(value))
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
  return Object.fromEntries(entries) as Partial<ViewSettings>
}

/** Coerces a number for setting `key` to the nearest valid value: rounded for integer settings and
 *  clamped to the range. Other values pass through. */
export function nearest(key: string, value: unknown): unknown {
  const setting: Setting | undefined = SETTINGS[key as keyof typeof SETTINGS]
  if (setting?.kind !== 'number' || typeof value !== 'number' || !Number.isFinite(value))
    return value
  const whole = setting.integer ? Math.round(value) : value
  return Math.min(setting.max ?? Infinity, Math.max(setting.min ?? -Infinity, whole))
}

const readers = new WeakMap<Partial<ViewSettings>, SettingsReader>()
const unset: SettingsReader = { get: (key) => defaults[key] }

/** A reader of `values` that falls back to defaults. Readers are cached per object, so anything
 *  derived from a reader stays equal while its settings do. */
export function reader(values?: Partial<ViewSettings>): SettingsReader {
  if (!values) return unset
  let found = readers.get(values)
  if (!found)
    readers.set(values, (found = { get: (key) => (key in values ? values[key]! : defaults[key]) }))
  return found
}
