/** The display settings of Network, Diagram and Monitor, plus accessibility, each defined once; VS
 *  Code owns the theme. `pnpm settings` writes them into package.json for VS Code Settings. */

import type { ColormapName } from '@latkit/gpu'

/** One setting: the default a reset restores and the values it takes. Null leaves a number or
 *  color to the view. */
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
      readonly default: number | null
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

/** Only a null default makes null a valid value. */
const num = <const I extends string, D extends number | null>(
  id: I,
  label: string,
  value: D,
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

/** When hover looks for what is under the pointer. */
const HOVER = [
  ['auto', 'Auto'],
  ['on', 'Always'],
  ['off', 'Off'],
] as const

/** Multisampling, by sample count. */
const MSAA = [
  [4, '4× multisample'],
  [1, 'Off'],
] as const

/** When the wheel zooms. */
const WHEEL = [
  ['zoom', 'Always'],
  ['modifier', 'With Ctrl or Cmd'],
] as const

/** How an axis writes its tick labels. */
const FORMATS = [
  ['auto', 'Auto'],
  ['fixed', 'Fixed'],
  ['scientific', 'Scientific'],
  ['engineering', 'Engineering'],
] as const

/** The colormaps a field can take, sequential then diverging. */
const COLORMAPS = [
  ['amber', 'Amber'],
  ['amp', 'Amp'],
  ['batlow', 'Batlow'],
  ['cividis', 'Cividis'],
  ['crest', 'Crest'],
  ['deep', 'Deep'],
  ['devon', 'Devon'],
  ['flare', 'Flare'],
  ['grays', 'Grays'],
  ['haline', 'Haline'],
  ['inferno', 'Inferno'],
  ['lajolla', 'Lajolla'],
  ['magma', 'Magma'],
  ['mako', 'Mako'],
  ['oslo', 'Oslo'],
  ['plasma', 'Plasma'],
  ['rocket', 'Rocket'],
  ['thermal', 'Thermal'],
  ['turku', 'Turku'],
  ['viridis', 'Viridis'],
  ['balance', 'Balance'],
  ['berlin', 'Berlin'],
  ['brbg', 'Brown / Green'],
  ['broc', 'Broc'],
  ['coolwarm', 'Cool / Warm'],
  ['cork', 'Cork'],
  ['icefire', 'Icefire'],
  ['managua', 'Managua'],
  ['piyg', 'Pink / Green'],
  ['puor', 'Purple / Orange'],
  ['rdbu', 'Red / Blue'],
  ['spectral', 'Spectral'],
  ['vanimo', 'Vanimo'],
  ['vik', 'Vik'],
  ['vlag', 'Vlag'],
] as const satisfies Options<ColormapName>

/** Every display setting, by category and group. A table: prettier would give each argument of a
 *  long row a line of its own. */
// prettier-ignore
export const SETTINGS = [
  category('accessibility', 'Accessibility', [
    group('', [
      choice('accessibility.motion', 'Motion', 'system',
        [['system', 'System'], ['full', 'Full'], ['reduce', 'Reduce']],
        'Full enables camera animation and interface motion. Reduce disables them. System follows the device.'),
      choice('accessibility.contrast', 'Contrast', 'system',
        [['system', 'System'], ['high', 'High']],
        'Increase contrast for text, borders and controls. System follows the device.'),
    ]),
  ]),
  category('network', 'Network', [
    group('Layers', [
      bool('network.markers', 'Vertices', true, 'Off hides vertex labels too.'),
      bool('network.lines', 'Edges', true, 'Off leaves the world’s borders drawn.'),
      bool('network.borders', 'Borders', true,
        'Draw coasts and country borders under a network on Earth.'),
      bool('network.poles', 'Height poles', false,
        'Draw stems from the ground up to raised vertices.'),
      bool('network.grid', 'Grid', false, 'Draw lines of latitude and longitude.'),
      bool('network.earthAxis', 'Earth axis', true, 'Draw the axis the globe turns on.'),
    ]),
    group('Size', [
      num('network.vertexRadiusPx', 'Vertex radius', 3, [0, 16, 0.5],
        'Marker radius before a bound size scales it.'),
      num('network.edgeWidthPx', 'Edge width', 1.4, [0, 8, 0.1]),
      num('network.zScale', 'Height', 3, [0, 8, 0.05],
        'Multiplies how high a bound height raises vertices.'),
      num('network.dashPeriodPx', 'Dash period', 12, [0, 48, 1],
        'Length of one dash on edges a field dashes.'),
      num('network.edgeSpacingPx', 'Parallel spacing', 0, [0, 24, 0.5],
        'Draw edges joining the same two vertices this far apart. 0 draws them over each other.'),
      num('network.pathWidthPx', 'Border width', 1, [0, 4, 0.25],
        'Stroke width of coasts and country borders.'),
      bool('network.shadows', 'Shadows', false, 'Lift markers off the lines with a soft shadow.'),
    ]),
    group('Labels', [
      bool('network.vertices.labels', 'Vertex labels', false, 'Name each vertex beside its marker.'),
      bool('network.edges.labels', 'Edge labels', false, 'Name each edge along its line.'),
      num('network.fontSizePx', 'Size', 10, [6, 32, 1]),
      num('network.labels.maxCount', 'Most labels', 200, [0, 8192, 1],
        'Labels drawn per type before the rest are thinned.'),
      num('network.labels.repeatSpacingPx', 'Repeat spacing', 0, [0, 512, 8],
        'Leave out a label repeating one placed this close, as for buses of one substation. 0 labels each.'),
      num('network.labelHaloPx', 'Halo', 2, [0, 8, 0.5],
        'How far the ground’s color reaches around label text.'),
      text('network.font', 'Font', ''),
      color('network.textColor', 'Color', null),
    ]),
    group('Lighting', [
      bool('network.daylight', 'Daylight', false,
        'Light a network on Earth by where the sun is now.'),
      num('network.nightFloor', 'Night floor', 0.55, [0, 1, 0.01],
        'Brightness of the network on the night side.'),
      num('network.surfaceNightFloor', 'Ground night floor', 0.15, [0, 1, 0.01],
        'Brightness of the ground on the night side.'),
      num('network.terminatorWidth', 'Terminator width', 0.12, [0, 0.5, 0.01],
        'Softness of the edge between day and night.'),
    ]),
    group('Highlight', [
      bool('network.selectedEnds', 'Selected edge ends', true,
        'Halo the vertices a selected edge joins.'),
      bool('network.hoverEnds', 'Hovered edge ends', false,
        'Halo the vertices a hovered edge joins.'),
      num('network.hoverScale', 'Hover growth', 1.25, [1, 3, 0.05],
        'How much a hovered vertex’s marker grows. 1 keeps its size.'),
      num('network.hoverWidthPx', 'Hover width', 4.75, [0, 16, 0.25]),
      num('network.selectedWidthPx', 'Selection width', 6, [0, 16, 0.25]),
      color('network.hoverColor', 'Hover color', null, 'Its alpha is the halo’s opacity.'),
      color('network.selectedColor', 'Selection color', null, 'Its alpha is the halo’s opacity.'),
    ]),
    group('Color', [
      choice('network.colormap', 'Colormap', 'viridis', COLORMAPS,
        'Ramp for fields bound to color.'),
      color('network.vertexColor', 'Vertex color', null,
        'Vertices while no field drives their color.'),
      color('network.edgeColor', 'Edge color', null, 'Edges while no field drives their color.'),
      color('network.background', 'Background', null),
      color('network.surfaceColor', 'Ground', null,
        'The globe, and the ground under a tilted view.'),
      color('network.gridColor', 'Grid color', null, 'Lines of latitude and longitude.'),
      color('network.pathColor', 'Border color', null, 'Coasts and country borders.'),
    ]),
    group('Camera', [
      choice('network.camera.projection', 'Projection', 'flat',
        [['flat', 'Flat'], ['tilt', 'Tilt'], ['globe', 'Globe']],
        'How a network first shows. Globe needs geography.'),
      num('network.fitPitch', 'Tilt', 55, [0, 80, 1],
        'How far a tilted view leans from straight down.'),
      num('network.fitBearing', 'Bearing', 0, [0, 359, 1], 'Rotation a fitted view settles at.'),
      num('network.orbitRate', 'Rotation speed', 1, [0, 10, 0.1],
        'Multiplies the auto-rotation of 12° a second.'),
      num('network.animationMs', 'Easing', 300, [0, 2000, 50], 'Duration of camera moves.'),
      num('network.fitPaddingPx', 'Fit padding', 32, [0, 200, 1],
        'Space kept around the network when it is fitted.'),
      num('network.revealPaddingPx', 'Reveal margin', 48, [0, 200, 1],
        'How far inside the edge a located element must sit.'),
    ]),
    group('Interaction', [
      choice('network.input.mode', 'Mode', 'navigate',
        [['navigate', 'Navigate'], ['inspect', 'Inspect']],
        'Navigate moves the view; Inspect only selects.'),
      choice('network.input.wheel', 'Wheel zoom', 'zoom', WHEEL, 'When the wheel zooms the view.'),
      bool('network.input.keyboard', 'Keyboard', true,
        'Pan, zoom and step through elements with the keys.'),
      num('network.pickRadiusPx', 'Pick radius', 8, [0, 32, 1],
        'How near the pointer must be to hover or select.'),
    ]),
    group('Quality', [
      choice('network.msaa', 'Antialiasing', 4, MSAA, 'Smooths edges at some cost.'),
      choice('network.hover', 'Hover search', 'auto', HOVER,
        'Auto pauses it while the view moves or runs slow.'),
      num('network.hoverBudgetMs', 'Hover budget', 2, [0.5, 16, 0.5],
        'Time a hover search may take per frame.'),
    ]),
  ]),
  category('monitor', 'Monitor', [
    group('Plot', [
      bool('monitor.xAxis.visible', 'Time axis', true),
      bool('monitor.yAxis.visible', 'Value axis', true),
      bool('monitor.yAxis.label', 'Value caption', false,
        'Name the plotted field above the value axis.'),
      bool('monitor.xAxis.grid', 'Time grid', true),
      bool('monitor.yAxis.grid', 'Value grid', true),
      color('monitor.background', 'Background', null),
      color('monitor.axisColor', 'Axis color', null),
      color('monitor.gridColor', 'Grid color', null),
    ]),
    group('Ticks', [
      num('monitor.xAxis.minSpacingPx', 'Time spacing', 80, [8, 400, 1],
        'Least gap between time ticks.'),
      choice('monitor.xAxis.format', 'Time format', 'auto', FORMATS),
      num('monitor.xAxis.precision', 'Time decimals', null, [0, 15, 1]),
      num('monitor.yAxis.minSpacingPx', 'Value spacing', 40, [8, 400, 1],
        'Least gap between value ticks.'),
      choice('monitor.yAxis.format', 'Value format', 'auto', FORMATS,
        'Auto writes very large and small values with exponents.'),
      num('monitor.yAxis.precision', 'Value decimals', null, [0, 15, 1]),
    ]),
    group('Text', [
      num('monitor.fontSizePx', 'Size', 12, [8, 24, 1],
        'Axis text size. The margins around the plot grow with it.'),
      text('monitor.font', 'Font', ''),
      color('monitor.textColor', 'Color', null),
    ]),
    group('Lines', [
      num('monitor.traceWidthPx', 'Width', 1.25, [0.1, 8, 0.05]),
      choice('monitor.interpolation', 'Interpolation', 'linear',
        [['linear', 'Linear'], ['step-before', 'Step before'], ['step-after', 'Step after']],
        'How a line joins one sample to the next.'),
      color('monitor.traceColor', 'Color', '#238b83'),
    ]),
    group('Scale', [
      bool('monitor.camera.fit', 'Fit values', true,
        'Keep the value axis fitted to the data in view.'),
      num('monitor.animationMs', 'Easing', 0, [0, 2000, 50], 'Duration of axis moves.'),
      num('monitor.fitPaddingPx', 'Fit padding', 32, [0, 200, 1],
        'Space kept around the values when they are fitted.'),
    ]),
    group('Selection', [
      num('monitor.selectedWidthPx', 'Selection width', 3, [0, 16, 0.25]),
      num('monitor.unselectedAlpha', 'Others’ opacity', 0.35, [0, 1, 0.01],
        'Opacity of the other lines while one is selected.'),
      color('monitor.selectedColor', 'Selection color', null),
      color('monitor.cursorColor', 'Playhead color', null, 'The line at the time on show.'),
    ]),
    group('Interaction', [
      choice('monitor.input.mode', 'Mode', 'inspect',
        [['inspect', 'Inspect'], ['navigate', 'Navigate']],
        'Navigate adds the Home key to fit the plot.'),
      bool('monitor.input.keyboard', 'Keyboard', true, 'Select and clear with the keys.'),
      num('monitor.pickRadiusPx', 'Pick radius', 8, [0, 32, 1],
        'How near the pointer must be to select a line.'),
    ]),
    group('Quality', [
      choice('monitor.msaa', 'Antialiasing', 1, MSAA,
        'Smooths lines. Changing it draws the history again.'),
      choice('monitor.hover', 'Hover search', 'off', HOVER,
        'Looks for the reading under the pointer.'),
      num('monitor.hoverBudgetMs', 'Hover budget', 2, [0.5, 16, 0.5],
        'Time a hover search may take per frame.'),
    ]),
  ]),
  category('diagram', 'Diagram', [
    group('Canvas', [
      color('diagram.background', 'Background', null),
      bool('diagram.grid', 'Dot grid', true),
      num('diagram.gridPitch', 'Grid pitch', 8, [1, 64, 1],
        'Grid spacing, which is also the snap and nudge step.'),
      num('diagram.gridMinSpacingPx', 'Dot spacing', 12, [4, 64, 1],
        'Dots thin out when closer than this on screen.'),
      color('diagram.gridColor', 'Grid color', null),
    ]),
    group('Blocks', [
      choice('diagram.shape', 'Shape', 'rounded', [['rectangle', 'Rectangle'], ['rounded', 'Rounded'],
        ['ellipse', 'Ellipse'], ['diamond', 'Diamond']]),
      num('diagram.cornerRadius', 'Corner radius', 6, [0, 32, 1],
        'Rounding of rounded blocks, groups, and wire bends.'),
      num('diagram.vertexPadding', 'Padding', 10, [1, 48, 1],
        'Space inside a block, and around a group.'),
      choice('diagram.labelPosition', 'Title', 'header',
        [['header', 'Header'], ['center', 'Center']],
        'Header gives the title a band of its own.'),
      num('diagram.outlineWidthPx', 'Outline width', 1, [0, 8, 0.25]),
      color('diagram.vertexColor', 'Fill', null, 'Blocks while no field drives their color.'),
      color('diagram.outlineColor', 'Outline color', null, 'Block and group outlines.'),
      color('diagram.groupColor', 'Group fill', null),
    ]),
    group('Ports', [
      bool('diagram.portLabels', 'Port names', true),
      choice('diagram.portMarker', 'Marker', 'directional',
        [['directional', 'Directional'], ['circle', 'Circle'], ['diamond', 'Diamond']]),
      num('diagram.portSize', 'Marker size', 8, [2, 24, 1],
        'Port markers, arrowheads, and junctions. They scale with zoom.'),
      num('diagram.portFontSize', 'Name size', 11, [6, 24, 1],
        'Port name size. It scales with zoom.'),
      num('diagram.portSpacing', 'Spacing', 22, [8, 64, 1], 'Distance between ports along a side.'),
    ]),
    group('Wires', [
      choice('diagram.edges.route', 'Routing', 'orthogonal',
        [['orthogonal', 'Right angles'], ['straight', 'Straight']]),
      choice('diagram.edges.appearance', 'Style', 'wire', [['wire', 'Wire'], ['tag', 'Tag']],
        'Tag draws named tags at the ends instead of a line.'),
      bool('diagram.edges.arrows', 'Arrowheads', true, 'Mark where each signal arrives.'),
      bool('diagram.junctions', 'Junctions', true, 'Dot where three or more wire segments meet.'),
      num('diagram.edgeWidthPx', 'Width', 1.5, [0.25, 8, 0.25],
        'Wire width while no field drives it.'),
      num('diagram.routeClearance', 'Clearance', 16, [1, 64, 1], 'Gap wires keep from blocks.'),
      color('diagram.edgeColor', 'Color', null,
        'Wires and ports while no field drives their color.'),
    ]),
    group('Labels', [
      bool('diagram.labels.visible', 'Titles', true, 'Show block, wire and group titles.'),
      num('diagram.fontSizePx', 'Size', 12, [6, 32, 1], 'Title size. It scales with zoom.'),
      num('diagram.labels.maxWidth', 'Width', null, [16, 1024, 8],
        'Widest a title runs before it wraps or ends.'),
      choice('diagram.labels.overflow', 'Overflow', 'ellipsis',
        [['ellipsis', 'Ellipsis'], ['wrap', 'Wrap']]),
      text('diagram.font', 'Font', ''),
      color('diagram.textColor', 'Color', null),
    ]),
    group('Layout', [
      choice('diagram.layout.algorithm', 'Layout', 'layered',
        [['layered', 'Layered'], ['stress', 'Stress']],
        'Arrange blocks without saved positions. Saved positions are always preserved.'),
      choice('diagram.layout.direction', 'Direction', 'right',
        [['right', 'Right'], ['left', 'Left'], ['down', 'Down'], ['up', 'Up']],
        'Where signals flow, rank to rank.'),
      num('diagram.layout.vertexGap', 'Block gap', 24, [0, 128, 1],
        'Space between blocks in a rank.'),
      num('diagram.layout.rankGap', 'Rank gap', 64, [0, 256, 1],
        'Space between ranks. It grows to fit wire titles.'),
      num('diagram.layout.sweeps', 'Crossing passes', 4, [0, 12, 1],
        'Passes spent untangling wires.'),
    ]),
    group('Highlight', [
      num('diagram.hoverWidthPx', 'Hover width', 3, [0, 16, 0.25]),
      num('diagram.selectedWidthPx', 'Selection width', 3, [0, 16, 0.25]),
      color('diagram.hoverColor', 'Hover color', null),
      color('diagram.selectedColor', 'Selection color', null),
    ]),
    group('Camera', [
      num('diagram.animationMs', 'Easing', 300, [0, 2000, 50],
        'Duration of camera and block moves.'),
      num('diagram.fitPaddingPx', 'Fit padding', 32, [0, 200, 1],
        'Space kept around the diagram when it is fitted.'),
      num('diagram.revealPaddingPx', 'Reveal margin', 48, [0, 200, 1],
        'How far inside the edge a located element must sit.'),
    ]),
    group('Interaction', [
      choice('diagram.input.mode', 'Mode', 'navigate',
        [['navigate', 'Navigate'], ['inspect', 'Inspect']],
        'Navigate moves the camera. Inspect only selects and opens menus.'),
      choice('diagram.input.wheel', 'Wheel zoom', 'zoom', WHEEL, 'When the wheel zooms the view.'),
      bool('diagram.input.keyboard', 'Keyboard', true, 'Pan, zoom, fit and step with the keys.'),
      num('diagram.pickRadiusPx', 'Pick radius', 8, [0, 32, 1],
        'How near the pointer must be to hover or select.'),
      num('diagram.input.dragThresholdPx', 'Drag threshold', 4, [0, 32, 1],
        'How far the mouse moves before a press becomes a drag.'),
      num('diagram.input.touchDragThresholdPx', 'Touch drag threshold', 8, [0, 48, 1],
        'How far a touch moves before it becomes a drag.'),
    ]),
    group('Quality', [
      choice('diagram.msaa', 'Antialiasing', 1, MSAA,
        'Every shape already smooths its own edges; multisampling adds only cost.'),
      choice('diagram.detail', 'Detail', 'auto', [['auto', 'Auto'], ['full', 'Full']],
        'Auto fades ports and arrowheads out as the view zooms out.'),
      choice('diagram.hover', 'Hover search', 'auto', HOVER,
        'Auto pauses it while the view moves or runs slow.'),
      num('diagram.hoverBudgetMs', 'Hover budget', 2, [0.5, 16, 0.5],
        'Time a hover search may take per frame.'),
    ]),
  ]),
] as const

type Definition = (typeof SETTINGS)[number]['groups'][number]['settings'][number]
/** A setting's value takes its default's type, widened for a number, whose default is a literal. */
type ValueOf<D extends Definition> = D extends { kind: 'number' }
  ? number | Extract<D['default'], null>
  : D['default']

export type SettingsValues = { [D in Definition as D['id']]: ValueOf<D> }
export type SettingKey = keyof SettingsValues
export type SettingsDocument = Partial<SettingsValues>
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
          value === null
            ? setting.default === null
            : typeof value === 'number' &&
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

export function reader(values: SettingsDocument = {}): SettingsReader {
  return { get: (key) => (key in values ? values[key]! : defaults[key]) }
}
