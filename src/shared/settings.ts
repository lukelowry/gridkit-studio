/** Every setting Studio contributes, each defined once: how GridKit runs, how much of its results
 *  stay read, and how the Network and the Monitor look. VS Code names each in its Settings by its
 *  id, and owns the theme, its contrast and its motion. `pnpm settings` writes them into
 *  package.json. */

import { type ColormapName, colormaps } from 'latkit'

/** What a setting is set for, as VS Code scopes it: a file's views, the machine GridKit runs on,
 *  or the window. */
type Scope = 'resource' | 'machine-overridable' | 'window'

/** One setting: the default a reset restores, the values it takes, and, in Markdown, what its id
 *  does not say. Null leaves a color to the theme. */
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
      readonly min: number
      readonly max?: number
      readonly integer: boolean
    }
  | { readonly kind: 'color'; readonly default: string | null }
  | { readonly kind: 'text'; readonly default: string }
)

/** A choice's options as value and label, in the order VS Code lists them. */
type Options<V> = readonly (readonly [value: V, label: string])[]

// A row reads: id, default, then the range or options of its kind, then the description.
const bool = (value: boolean, description?: string) =>
  ({ kind: 'boolean', scope: 'resource', default: value, description }) as const

const num = (
  value: number,
  [min, max]: readonly [min: number, max?: number],
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
  [min, max]: readonly [min: number, max: number],
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

/** A setting of where GridKit runs, which a workspace may override on its machine. */
const machine = <S extends Setting>(
  setting: S,
): Omit<S, 'scope'> & { scope: 'machine-overridable' } => ({
  ...setting,
  scope: 'machine-overridable',
})

/** A setting of the window, whatever it shows. */
const windowed = <S extends Setting>(setting: S): Omit<S, 'scope'> & { scope: 'window' } => ({
  ...setting,
  scope: 'window',
})

/** latkit's colormaps that map a number, as it names and labels them: all but the categorical. */
const COLORMAPS: Options<ColormapName> = colormaps()
  .filter((map) => map.kind !== 'categorical')
  .map((map) => [map.name, map.label] as const)
/** latkit's categorical colormaps, which give each trace of a plot its own color. */
const TRACE_COLORMAPS: Options<ColormapName> = colormaps()
  .filter((map) => map.kind === 'categorical')
  .map((map) => [map.name, map.label] as const)
const WHEEL = [
  ['wheel', 'Wheel'],
  ['modifier', 'Modifier + wheel'],
  ['off', 'Off'],
] as const
/** The Network's wheel can also pan, as a trackpad scrolls. The Monitor's wheel scrolls its plots. */
const NETWORK_WHEEL = [['wheel', 'Wheel'], ['trackpad', 'Trackpad'], ...WHEEL.slice(1)] as const
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
/** The image Studio runs GridKit from where GridKit is not installed. */
const IMAGE = 'ghcr.io/birchfieldresearchgroup/gridkit:develop-perf'

/** The settings by id, in the order VS Code lists them: first those of GridKit itself, then each
 *  view's, which its id starts with. */
export const SETTINGS = {
  gridkitPath: machine(
    text('', 'Where GridKit is installed, such as `/opt/gridkit`. Empty finds GridKit on `PATH`.'),
  ),
  gridkitImage: machine(
    text(
      IMAGE,
      `The container image GridKit runs from, in Docker or Podman, when GridKit is not installed where the workspace is. Pull it yourself first (\`docker pull ${IMAGE}\`): GridKit Studio never pulls images. Empty runs only an installed GridKit.`,
    ),
  ),
  containerCli: machine(
    text(
      '',
      'The container CLI that runs **GridKit Image**: `docker`, `podman`, or a path to either. Empty uses `docker`, else `podman`, on `PATH`.',
    ),
  ),
  gridkitProgram: machine(
    text(
      'DynamicSimulation',
      'The GridKit program a run starts, with the solver file as its one argument. It is found under **GridKit Path**, on `PATH`, or in **GridKit Image**.',
    ),
  ),
  catalog: machine(
    text(
      '',
      "A catalog of GridKit's classes to use in place of GridKit Studio's own, in the same form, for a GridKit build whose classes differ. A relative path starts at the first workspace folder. It is read when the window opens.",
    ),
  ),
  resultCacheMiB: windowed(
    num(
      256,
      [0],
      'Memory per window for results no view shows, in MiB, so they open again at once. Past it, those unused longest are closed.',
    ),
  ),

  'network.projection': choice('mercator', [
    ['mercator', 'Mercator'],
    ['globe', 'Globe'],
  ]),
  'network.tilt': int(0, [0, 75], 'Degrees from straight down.'),
  'network.orbit': int(0, [-90, 90], 'Degrees per second.'),
  'network.labels': bool(false),
  'network.vertexRadius': num(
    2.5,
    [EDGE_WIDTH, 12],
    'Radius in CSS pixels, never under the edge width, so a vertex shows past the edges that meet it. Size mappings start from this radius.',
  ),
  'network.edgeWidth': num(
    EDGE_WIDTH,
    [EDGE_WIDTH, 8],
    `Width in CSS pixels, at least ${EDGE_WIDTH}, as a thinner line can't hide what is behind it. Width mappings start from this width.`,
  ),
  'network.colormap': choice('viridis', COLORMAPS),
  'network.transitionDuration': num(0.3, [0, 2], 'Seconds.'),
  'network.height': num(
    0.2,
    [0.01, 1],
    'How high the highest mapped value raises a vertex: a share of the distance across the case.',
  ),
  'network.wheelBehavior': choice(
    'wheel',
    NETWORK_WHEEL,
    'Trackpad scrolls to pan and pinches to zoom.',
  ),
  'network.motion': choice('system', MOTION),
  'network.pickingDistance': int(
    8,
    [0, 32],
    'How near the pointer finds an element, in CSS pixels.',
  ),
  'network.map.source': choice('borders', [
    ['borders', 'Bundled borders'],
    ['streets', 'Street map'],
    ['none', 'None'],
  ]),
  'network.map.tilesUrl': text('https://tiles.openfreemap.org/planet'),
  'network.map.attribution': text('© OpenStreetMap contributors · OpenFreeMap'),
  'network.map.daylight': bool(false),
  'network.map.groundColor': color(null, 'Null follows the current VS Code theme.'),
  'network.map.nightBrightness': num(0.3, [0, 1]),

  'monitor.interpolation': choice('linear', [
    ['linear', 'Linear'],
    ['step', 'Step'],
  ]),
  'monitor.lineWidth': num(1, [0.25, 8], 'CSS pixels.'),
  'monitor.colormap': choice('tab10', TRACE_COLORMAPS),
  'monitor.wheelBehavior': choice('wheel', WHEEL),
  'monitor.motion': choice('system', MOTION),
  'monitor.pickingDistance': int(8, [0, 32], 'How near the pointer finds a trace, in CSS pixels.'),
} as const satisfies Record<string, Setting>

type Definitions = typeof SETTINGS
/** Every setting's value, which takes its default's type. */
export type Settings = { [K in keyof Definitions]: Definitions[K]['default'] }
/** The settings of how the views look, which the pages draw with: each view's start with its name. */
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

/** `input` as view settings, each of its kind and range: a whole change is checked before any of it
 *  is taken. */
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
          value >= setting.min &&
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

const readers = new WeakMap<Partial<ViewSettings>, SettingsReader>()
const unset: SettingsReader = { get: (key) => defaults[key] }

/** The settings in `values`, else their defaults. Each object has one reader, so what is derived
 *  from a reader stays equal while its settings do. */
export function reader(values?: Partial<ViewSettings>): SettingsReader {
  if (!values) return unset
  let found = readers.get(values)
  if (!found)
    readers.set(values, (found = { get: (key) => (key in values ? values[key]! : defaults[key]) }))
  return found
}
