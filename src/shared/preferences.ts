/** The display settings of Network, Diagram and Monitor, each defined once. VS Code owns the theme. */
/** The settings catalog: controls, defaults, types and validation share these definitions. */

import type { ColormapName } from '@latkit/gpu'

export interface SelectOption<T> {
  readonly value: T
  readonly label: string
  readonly group?: string
}
/** A setting's value: a switch's, a choice's option, a number, a color as `#rrggbb` or `#rrggbbaa`, or
 *  text. Null is a number or color left to its default, which the setting's `placeholder` names. */
export type SettingValue = boolean | string | number | null

/** One setting: what search reads, the default a reset restores, and the control its kind draws. */
export type Setting = {
  readonly id: string
  readonly label: string
  /** A one-line note, only where it says what the label does not. */
  readonly description?: string
  readonly keywords?: readonly string[]
} & (
  | { readonly kind: 'boolean'; readonly default: boolean }
  | {
      readonly kind: 'choice'
      readonly default: string | number
      readonly options: readonly SelectOption<string | number>[]
    }
  | {
      readonly kind: 'number'
      readonly default: number | null
      readonly min: number
      readonly max: number
      readonly step: number
      readonly unit?: string
      /** Shown while the value is null, which only a null default allows. */
      readonly placeholder?: string
    }
  | {
      readonly kind: 'color'
      readonly default: string | null
      /** What draws the color while none is set: `Theme`, or the renderer's `Default`. */
      readonly placeholder: string
      /** That color, as CSS, for the swatch. */
      readonly swatch: string
    }
  | { readonly kind: 'text'; readonly default: string; readonly placeholder?: string }
)

/** A run of settings in a category, under its heading; one without a label runs straight on. */
interface SettingsGroup {
  readonly id: string
  readonly label?: string
  readonly settings: readonly Setting[]
}

/** A category of the index. Ids, of categories, groups and settings alike, are unique throughout. */
export interface SettingsCategory {
  readonly icon: string
  readonly id: string
  readonly label: string
  readonly groups: readonly SettingsGroup[]
}

/** When hover looks for what is under the pointer. */
const HOVER = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'Always' },
  { value: 'off', label: 'Off' },
] as const

/** Multisampling, by sample count. */
const MSAA = [
  { value: 4, label: '4× multisample' },
  { value: 1, label: 'Off' },
] as const

/** When the wheel zooms. */
const WHEEL = [
  { value: 'zoom', label: 'Always' },
  { value: 'modifier', label: 'With Ctrl or Cmd' },
] as const

/** How an axis writes its tick labels. */
const FORMATS = [
  { value: 'auto', label: 'Auto' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'scientific', label: 'Scientific' },
  { value: 'engineering', label: 'Engineering' },
] as const

/** The colormaps a field can take, sequential then diverging, each with a swatch of itself. */
const COLORMAPS = [
  { value: 'amber', label: 'Amber', group: 'Sequential' },
  { value: 'amp', label: 'Amp', group: 'Sequential' },
  { value: 'batlow', label: 'Batlow', group: 'Sequential' },
  { value: 'cividis', label: 'Cividis', group: 'Sequential' },
  { value: 'crest', label: 'Crest', group: 'Sequential' },
  { value: 'deep', label: 'Deep', group: 'Sequential' },
  { value: 'devon', label: 'Devon', group: 'Sequential' },
  { value: 'flare', label: 'Flare', group: 'Sequential' },
  { value: 'grays', label: 'Grays', group: 'Sequential' },
  { value: 'haline', label: 'Haline', group: 'Sequential' },
  { value: 'inferno', label: 'Inferno', group: 'Sequential' },
  { value: 'lajolla', label: 'Lajolla', group: 'Sequential' },
  { value: 'magma', label: 'Magma', group: 'Sequential' },
  { value: 'mako', label: 'Mako', group: 'Sequential' },
  { value: 'oslo', label: 'Oslo', group: 'Sequential' },
  { value: 'plasma', label: 'Plasma', group: 'Sequential' },
  { value: 'rocket', label: 'Rocket', group: 'Sequential' },
  { value: 'thermal', label: 'Thermal', group: 'Sequential' },
  { value: 'turku', label: 'Turku', group: 'Sequential' },
  { value: 'viridis', label: 'Viridis', group: 'Sequential' },
  { value: 'balance', label: 'Balance', group: 'Diverging' },
  { value: 'berlin', label: 'Berlin', group: 'Diverging' },
  { value: 'brbg', label: 'Brown / Green', group: 'Diverging' },
  { value: 'broc', label: 'Broc', group: 'Diverging' },
  { value: 'coolwarm', label: 'Cool / Warm', group: 'Diverging' },
  { value: 'cork', label: 'Cork', group: 'Diverging' },
  { value: 'icefire', label: 'Icefire', group: 'Diverging' },
  { value: 'managua', label: 'Managua', group: 'Diverging' },
  { value: 'piyg', label: 'Pink / Green', group: 'Diverging' },
  { value: 'puor', label: 'Purple / Orange', group: 'Diverging' },
  { value: 'rdbu', label: 'Red / Blue', group: 'Diverging' },
  { value: 'spectral', label: 'Spectral', group: 'Diverging' },
  { value: 'vanimo', label: 'Vanimo', group: 'Diverging' },
  { value: 'vik', label: 'Vik', group: 'Diverging' },
  { value: 'vlag', label: 'Vlag', group: 'Diverging' },
] as const satisfies readonly SelectOption<ColormapName>[]

/** A theme token at a fraction of its strength, as the renderers' faint lines draw it. */
const faint = (token: string, share: number): string =>
  `color-mix(in srgb, var(${token}) ${share}%, transparent)`

/** Application preferences, grouped for the editor. */
export const SETTINGS = [
  {
    id: 'accessibility',
    icon: 'accessibility',
    label: 'Accessibility',
    groups: [
      {
        id: 'accessibility.all',
        settings: [
          {
            kind: 'choice',
            id: 'accessibility.motion',
            label: 'Motion',
            description: 'Reduce camera animation and interface motion. System follows the device.',
            keywords: ['animation', 'reduce', 'movement'],
            default: 'system',
            options: [
              { value: 'system', label: 'System' },
              { value: 'reduce', label: 'Reduce' },
            ],
          },
          {
            kind: 'choice',
            id: 'accessibility.contrast',
            label: 'Contrast',
            description:
              'Increase contrast for text, borders and controls. System follows the device.',
            keywords: ['high', 'visibility', 'readability'],
            default: 'system',
            options: [
              { value: 'system', label: 'System' },
              { value: 'high', label: 'High' },
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'network',
    icon: 'spatial',
    label: 'Network',
    groups: [
      {
        id: 'network.layers',
        label: 'Layers',
        settings: [
          {
            kind: 'boolean',
            id: 'network.markers',
            label: 'Vertices',
            description: 'Off hides vertex labels too.',
            default: true,
          },
          {
            kind: 'boolean',
            id: 'network.lines',
            label: 'Edges',
            description: 'Off leaves the world’s borders drawn.',
            default: true,
          },
          {
            kind: 'boolean',
            id: 'network.borders',
            label: 'Borders',
            description: 'Draw coasts and country borders under a network on Earth.',
            default: true,
          },
          {
            kind: 'boolean',
            id: 'network.poles',
            label: 'Height poles',
            description: 'Draw stems from the ground up to raised vertices.',
            default: false,
          },
          {
            kind: 'boolean',
            id: 'network.grid',
            label: 'Grid',
            description: 'Draw lines of latitude and longitude.',
            default: false,
          },
          {
            kind: 'boolean',
            id: 'network.earthAxis',
            label: 'Earth axis',
            description: 'Draw the axis the globe turns on.',
            default: true,
          },
        ],
      },
      {
        id: 'network.size',
        label: 'Size',
        settings: [
          {
            kind: 'number',
            id: 'network.vertexRadiusPx',
            label: 'Vertex radius',
            description: 'Marker radius before a bound size scales it.',
            default: 3,
            min: 0,
            max: 16,
            step: 0.5,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'network.edgeWidthPx',
            label: 'Edge width',
            default: 1.4,
            min: 0,
            max: 8,
            step: 0.1,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'network.zScale',
            label: 'Height',
            description: 'Multiplies how high a bound height raises vertices.',
            default: 3,
            min: 0,
            max: 8,
            step: 0.05,
          },
          {
            kind: 'number',
            id: 'network.dashPeriodPx',
            label: 'Dash period',
            description: 'Length of one dash on edges a field dashes.',
            default: 12,
            min: 0,
            max: 48,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'network.pathWidthPx',
            label: 'Border width',
            description: 'Stroke width of coasts and country borders.',
            default: 1,
            min: 0,
            max: 4,
            step: 0.25,
            unit: 'px',
          },
        ],
      },
      {
        id: 'network.labels',
        label: 'Labels',
        settings: [
          {
            kind: 'boolean',
            id: 'network.vertices.labels',
            label: 'Vertex labels',
            description: 'Name each vertex beside its marker.',
            default: true,
          },
          {
            kind: 'boolean',
            id: 'network.edges.labels',
            label: 'Edge labels',
            description: 'Name each edge along its line.',
            default: false,
          },
          {
            kind: 'number',
            id: 'network.fontSizePx',
            label: 'Size',
            keywords: ['font'],
            default: 10,
            min: 6,
            max: 32,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'network.labels.maxCount',
            label: 'Most labels',
            description: 'Labels drawn per type before the rest are thinned.',
            keywords: ['limit', 'count'],
            default: 200,
            min: 0,
            max: 8192,
            step: 1,
          },
          {
            kind: 'number',
            id: 'network.labels.repeatSpacingPx',
            label: 'Repeat spacing',
            description:
              'Leave out a label repeating one placed this close, as for buses of one substation. 0 labels each.',
            keywords: ['duplicate', 'substation'],
            default: 0,
            min: 0,
            max: 512,
            step: 8,
            unit: 'px',
          },
          {
            kind: 'text',
            id: 'network.font',
            label: 'Font',
            keywords: ['typeface'],
            default: '',
            placeholder: 'system-ui',
          },
          {
            kind: 'color',
            id: 'network.textColor',
            label: 'Color',
            default: null,
            placeholder: 'Default',
            swatch: 'rgb(235 240 250)',
          },
        ],
      },
      {
        id: 'network.lighting',
        label: 'Lighting',
        settings: [
          {
            kind: 'boolean',
            id: 'network.daylight',
            label: 'Daylight',
            description: 'Light a network on Earth by where the sun is now.',
            keywords: ['sun', 'solar', 'night'],
            default: false,
          },
          {
            kind: 'number',
            id: 'network.nightFloor',
            label: 'Night floor',
            description: 'Brightness of the network on the night side.',
            default: 0.55,
            min: 0,
            max: 1,
            step: 0.01,
          },
          {
            kind: 'number',
            id: 'network.surfaceNightFloor',
            label: 'Ground night floor',
            description: 'Brightness of the ground on the night side.',
            default: 0.15,
            min: 0,
            max: 1,
            step: 0.01,
          },
          {
            kind: 'number',
            id: 'network.terminatorWidth',
            label: 'Terminator width',
            description: 'Softness of the edge between day and night.',
            default: 0.12,
            min: 0,
            max: 0.5,
            step: 0.01,
          },
        ],
      },
      {
        id: 'network.highlight',
        label: 'Highlight',
        settings: [
          {
            kind: 'boolean',
            id: 'network.selectedEnds',
            label: 'Selected edge ends',
            description: 'Halo the vertices a selected edge joins.',
            keywords: ['endpoints'],
            default: true,
          },
          {
            kind: 'boolean',
            id: 'network.hoverEnds',
            label: 'Hovered edge ends',
            description: 'Halo the vertices a hovered edge joins.',
            keywords: ['endpoints'],
            default: false,
          },
          {
            kind: 'number',
            id: 'network.hoverWidthPx',
            label: 'Hover width',
            default: 4.75,
            min: 0,
            max: 16,
            step: 0.25,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'network.selectedWidthPx',
            label: 'Selection width',
            default: 6,
            min: 0,
            max: 16,
            step: 0.25,
            unit: 'px',
          },
          {
            kind: 'color',
            id: 'network.hoverColor',
            label: 'Hover color',
            description: 'Its alpha is the halo’s opacity.',
            keywords: ['focus', 'opacity'],
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-focus-ring)',
          },
          {
            kind: 'color',
            id: 'network.selectedColor',
            label: 'Selection color',
            description: 'Its alpha is the halo’s opacity.',
            keywords: ['focus', 'opacity'],
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-focus-ring)',
          },
        ],
      },
      {
        id: 'network.color',
        label: 'Color',
        settings: [
          {
            kind: 'choice',
            id: 'network.colormap',
            label: 'Colormap',
            description: 'Ramp for fields bound to color.',
            keywords: ['palette', 'ramp', 'scale'],
            default: 'viridis',
            options: COLORMAPS,
          },
          {
            kind: 'color',
            id: 'network.vertexColor',
            label: 'Vertex color',
            description: 'Vertices while no field drives their color.',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-network)',
          },
          {
            kind: 'color',
            id: 'network.edgeColor',
            label: 'Edge color',
            description: 'Edges while no field drives their color.',
            default: null,
            placeholder: 'Colors of its ends',
            swatch: 'var(--color-network)',
          },
          {
            kind: 'color',
            id: 'network.background',
            label: 'Background',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-bg)',
          },
          {
            kind: 'color',
            id: 'network.surfaceColor',
            label: 'Ground',
            description: 'The globe, and the ground under a tilted view.',
            keywords: ['surface'],
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-surface-2)',
          },
          {
            kind: 'color',
            id: 'network.gridColor',
            label: 'Grid color',
            description: 'Lines of latitude and longitude.',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-border)',
          },
          {
            kind: 'color',
            id: 'network.pathColor',
            label: 'Border color',
            description: 'Coasts and country borders.',
            default: null,
            placeholder: 'Theme',
            swatch: faint('--color-text-3', 50),
          },
        ],
      },
      {
        id: 'network.camera',
        label: 'Camera',
        settings: [
          {
            kind: 'choice',
            id: 'network.camera.projection',
            label: 'Projection',
            description: 'How a network first shows. Globe needs geography.',
            default: 'flat',
            options: [
              { value: 'flat', label: 'Flat' },
              { value: 'tilt', label: 'Tilt' },
              { value: 'globe', label: 'Globe' },
            ],
          },
          {
            kind: 'number',
            id: 'network.fitPitch',
            label: 'Tilt',
            description: 'How far a tilted view leans from straight down.',
            keywords: ['pitch'],
            default: 55,
            min: 0,
            max: 80,
            step: 1,
            unit: '°',
          },
          {
            kind: 'number',
            id: 'network.fitBearing',
            label: 'Bearing',
            description: 'Rotation a fitted view settles at.',
            default: 0,
            min: 0,
            max: 359,
            step: 1,
            unit: '°',
          },
          {
            kind: 'number',
            id: 'network.orbitRate',
            label: 'Rotation speed',
            description: 'Multiplies the auto-rotation of 12° a second.',
            keywords: ['orbit'],
            default: 1,
            min: 0,
            max: 10,
            step: 0.1,
          },
          {
            kind: 'number',
            id: 'network.animationMs',
            label: 'Easing',
            description: 'Duration of camera moves.',
            keywords: ['animation'],
            default: 300,
            min: 0,
            max: 2000,
            step: 50,
            unit: 'ms',
          },
          {
            kind: 'number',
            id: 'network.fitPaddingPx',
            label: 'Fit padding',
            description: 'Space kept around the network when it is fitted.',
            default: 32,
            min: 0,
            max: 200,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'network.revealPaddingPx',
            label: 'Reveal margin',
            description: 'How far inside the edge a located element must sit.',
            default: 48,
            min: 0,
            max: 200,
            step: 1,
            unit: 'px',
          },
        ],
      },
      {
        id: 'network.interaction',
        label: 'Interaction',
        settings: [
          {
            kind: 'choice',
            id: 'network.input.mode',
            label: 'Mode',
            description: 'Navigate moves the view; Inspect only selects.',
            keywords: ['pan', 'zoom', 'input'],
            default: 'navigate',
            options: [
              { value: 'navigate', label: 'Navigate' },
              { value: 'inspect', label: 'Inspect' },
            ],
          },
          {
            kind: 'choice',
            id: 'network.input.wheel',
            label: 'Wheel zoom',
            description: 'When the wheel zooms the view.',
            keywords: ['scroll', 'mouse'],
            default: 'zoom',
            options: WHEEL,
          },
          {
            kind: 'boolean',
            id: 'network.input.keyboard',
            label: 'Keyboard',
            description: 'Pan, zoom and step through elements with the keys.',
            default: true,
          },
          {
            kind: 'number',
            id: 'network.pickRadiusPx',
            label: 'Pick radius',
            description: 'How near the pointer must be to hover or select.',
            default: 8,
            min: 0,
            max: 32,
            step: 1,
            unit: 'px',
          },
        ],
      },
      {
        id: 'network.quality',
        label: 'Quality',
        settings: [
          {
            kind: 'choice',
            id: 'network.msaa',
            label: 'Antialiasing',
            description: 'Smooths edges at some cost.',
            keywords: ['msaa', 'multisample'],
            default: 4,
            options: MSAA,
          },
          {
            kind: 'choice',
            id: 'network.hover',
            label: 'Hover search',
            description: 'Auto pauses it while the view moves or runs slow.',
            keywords: ['pick', 'performance'],
            default: 'auto',
            options: HOVER,
          },
          {
            kind: 'number',
            id: 'network.hoverBudgetMs',
            label: 'Hover budget',
            description: 'Time a hover search may take per frame.',
            keywords: ['performance'],
            default: 2,
            min: 0.5,
            max: 16,
            step: 0.5,
            unit: 'ms',
          },
        ],
      },
    ],
  },
  {
    id: 'monitor',
    icon: 'monitor',
    label: 'Monitor',
    groups: [
      {
        id: 'monitor.plot',
        label: 'Plot',
        settings: [
          {
            kind: 'boolean',
            id: 'monitor.xAxis.visible',
            label: 'Time axis',
            default: true,
          },
          {
            kind: 'boolean',
            id: 'monitor.yAxis.visible',
            label: 'Value axis',
            default: true,
          },
          {
            kind: 'boolean',
            id: 'monitor.yAxis.label',
            label: 'Value caption',
            description: 'Name the plotted field above the value axis.',
            default: false,
          },
          {
            kind: 'boolean',
            id: 'monitor.xAxis.grid',
            label: 'Time grid',
            default: true,
          },
          {
            kind: 'boolean',
            id: 'monitor.yAxis.grid',
            label: 'Value grid',
            default: true,
          },
          {
            kind: 'color',
            id: 'monitor.background',
            label: 'Background',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-surface-1)',
          },
          {
            kind: 'color',
            id: 'monitor.axisColor',
            label: 'Axis color',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-border)',
          },
          {
            kind: 'color',
            id: 'monitor.gridColor',
            label: 'Grid color',
            default: null,
            placeholder: 'Theme',
            swatch: faint('--color-text-3', 15),
          },
        ],
      },
      {
        id: 'monitor.ticks',
        label: 'Ticks',
        settings: [
          {
            kind: 'number',
            id: 'monitor.xAxis.minSpacingPx',
            label: 'Time spacing',
            description: 'Least gap between time ticks.',
            default: 80,
            min: 8,
            max: 400,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'choice',
            id: 'monitor.xAxis.format',
            label: 'Time format',
            default: 'auto',
            options: FORMATS,
          },
          {
            kind: 'number',
            id: 'monitor.xAxis.precision',
            label: 'Time decimals',
            keywords: ['precision'],
            default: null,
            min: 0,
            max: 15,
            step: 1,
            placeholder: 'Auto',
          },
          {
            kind: 'number',
            id: 'monitor.yAxis.minSpacingPx',
            label: 'Value spacing',
            description: 'Least gap between value ticks.',
            default: 40,
            min: 8,
            max: 400,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'choice',
            id: 'monitor.yAxis.format',
            label: 'Value format',
            description: 'Auto writes very large and small values with exponents.',
            default: 'auto',
            options: FORMATS,
          },
          {
            kind: 'number',
            id: 'monitor.yAxis.precision',
            label: 'Value decimals',
            keywords: ['precision'],
            default: null,
            min: 0,
            max: 15,
            step: 1,
            placeholder: 'Auto',
          },
        ],
      },
      {
        id: 'monitor.text',
        label: 'Text',
        settings: [
          {
            kind: 'number',
            id: 'monitor.fontSizePx',
            label: 'Size',
            description: 'Axis text size. The margins around the plot grow with it.',
            keywords: ['font'],
            default: 12,
            min: 8,
            max: 24,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'text',
            id: 'monitor.font',
            label: 'Font',
            keywords: ['typeface'],
            default: '',
            placeholder: 'JetBrains Mono',
          },
          {
            kind: 'color',
            id: 'monitor.textColor',
            label: 'Color',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-text-2)',
          },
        ],
      },
      {
        id: 'monitor.lines',
        label: 'Lines',
        settings: [
          {
            kind: 'number',
            id: 'monitor.traceWidthPx',
            label: 'Width',
            default: 1.25,
            min: 0.1,
            max: 8,
            step: 0.05,
            unit: 'px',
          },
          {
            kind: 'choice',
            id: 'monitor.interpolation',
            label: 'Interpolation',
            description: 'How a line joins one sample to the next.',
            keywords: ['step'],
            default: 'linear',
            options: [
              { value: 'linear', label: 'Linear' },
              { value: 'step-before', label: 'Step before' },
              { value: 'step-after', label: 'Step after' },
            ],
          },
          {
            kind: 'color',
            id: 'monitor.traceColor',
            label: 'Color',
            default: '#238b83',
            placeholder: 'Default',
            swatch: '#238b83',
          },
        ],
      },
      {
        id: 'monitor.scale',
        label: 'Scale',
        settings: [
          {
            kind: 'boolean',
            id: 'monitor.camera.fit',
            label: 'Fit values',
            description: 'Keep the value axis fitted to the data in view.',
            keywords: ['auto', 'range'],
            default: true,
          },
          {
            kind: 'number',
            id: 'monitor.domainPadding',
            label: 'Value margin',
            description: 'Room above and below fitted data, as a share of its range.',
            keywords: ['padding'],
            default: 0.1,
            min: 0,
            max: 1,
            step: 0.01,
          },
          {
            kind: 'number',
            id: 'monitor.animationMs',
            label: 'Easing',
            description: 'Duration of axis moves.',
            keywords: ['animation'],
            default: 0,
            min: 0,
            max: 2000,
            step: 50,
            unit: 'ms',
          },
        ],
      },
      {
        id: 'monitor.selection',
        label: 'Selection',
        settings: [
          {
            kind: 'number',
            id: 'monitor.selectedWidthPx',
            label: 'Selection width',
            default: 3,
            min: 0,
            max: 16,
            step: 0.25,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'monitor.unselectedAlpha',
            label: 'Others’ opacity',
            description: 'Opacity of the other lines while one is selected.',
            default: 0.35,
            min: 0,
            max: 1,
            step: 0.01,
          },
          {
            kind: 'color',
            id: 'monitor.selectedColor',
            label: 'Selection color',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-primary-text)',
          },
          {
            kind: 'color',
            id: 'monitor.cursorColor',
            label: 'Playhead color',
            description: 'The line at the time on show.',
            keywords: ['cursor'],
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-primary-text)',
          },
        ],
      },
      {
        id: 'monitor.interaction',
        label: 'Interaction',
        settings: [
          {
            kind: 'choice',
            id: 'monitor.input.mode',
            label: 'Mode',
            description: 'Navigate adds the Home key to fit the plot.',
            keywords: ['input'],
            default: 'inspect',
            options: [
              { value: 'inspect', label: 'Inspect' },
              { value: 'navigate', label: 'Navigate' },
            ],
          },
          {
            kind: 'boolean',
            id: 'monitor.input.keyboard',
            label: 'Keyboard',
            description: 'Select and clear with the keys.',
            default: true,
          },
          {
            kind: 'number',
            id: 'monitor.pickRadiusPx',
            label: 'Pick radius',
            description: 'How near the pointer must be to select a line.',
            default: 8,
            min: 0,
            max: 32,
            step: 1,
            unit: 'px',
          },
        ],
      },
      {
        id: 'monitor.quality',
        label: 'Quality',
        settings: [
          {
            kind: 'choice',
            id: 'monitor.msaa',
            label: 'Antialiasing',
            description: 'Smooths lines. Changing it draws the history again.',
            keywords: ['msaa', 'multisample'],
            default: 1,
            options: MSAA,
          },
          {
            kind: 'choice',
            id: 'monitor.hover',
            label: 'Hover search',
            description: 'Looks for the reading under the pointer.',
            keywords: ['pick', 'performance'],
            default: 'off',
            options: HOVER,
          },
          {
            kind: 'number',
            id: 'monitor.hoverBudgetMs',
            label: 'Hover budget',
            description: 'Time a hover search may take per frame.',
            keywords: ['performance'],
            default: 2,
            min: 0.5,
            max: 16,
            step: 0.5,
            unit: 'ms',
          },
        ],
      },
    ],
  },
  {
    id: 'diagram',
    icon: 'diagram',
    label: 'Diagram',
    groups: [
      {
        id: 'diagram.canvas',
        label: 'Canvas',
        settings: [
          {
            kind: 'color',
            id: 'diagram.background',
            label: 'Background',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-bg)',
          },
          {
            kind: 'boolean',
            id: 'diagram.grid',
            label: 'Dot grid',
            default: true,
          },
          {
            kind: 'number',
            id: 'diagram.gridPitch',
            label: 'Grid pitch',
            description: 'Grid spacing, which is also the snap and nudge step.',
            default: 8,
            min: 1,
            max: 64,
            step: 1,
          },
          {
            kind: 'number',
            id: 'diagram.gridMinSpacingPx',
            label: 'Dot spacing',
            description: 'Dots thin out when closer than this on screen.',
            default: 12,
            min: 4,
            max: 64,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'color',
            id: 'diagram.gridColor',
            label: 'Grid color',
            default: null,
            placeholder: 'Theme',
            swatch: faint('--color-text-3', 15),
          },
        ],
      },
      {
        id: 'diagram.blocks',
        label: 'Blocks',
        settings: [
          {
            kind: 'choice',
            id: 'diagram.shape',
            label: 'Shape',
            default: 'rounded',
            options: [
              { value: 'rectangle', label: 'Rectangle' },
              { value: 'rounded', label: 'Rounded' },
              { value: 'ellipse', label: 'Ellipse' },
              { value: 'diamond', label: 'Diamond' },
            ],
          },
          {
            kind: 'number',
            id: 'diagram.cornerRadius',
            label: 'Corner radius',
            description: 'Rounding of rounded blocks, groups, and wire bends.',
            default: 6,
            min: 0,
            max: 32,
            step: 1,
          },
          {
            kind: 'number',
            id: 'diagram.vertexPadding',
            label: 'Padding',
            description: 'Space inside a block, and around a group.',
            default: 10,
            min: 1,
            max: 48,
            step: 1,
          },
          {
            kind: 'choice',
            id: 'diagram.labelPosition',
            label: 'Title',
            description: 'Header gives the title a band of its own.',
            default: 'header',
            options: [
              { value: 'header', label: 'Header' },
              { value: 'center', label: 'Center' },
            ],
          },
          {
            kind: 'number',
            id: 'diagram.outlineWidthPx',
            label: 'Outline width',
            default: 1,
            min: 0,
            max: 8,
            step: 0.25,
            unit: 'px',
          },
          {
            kind: 'color',
            id: 'diagram.vertexColor',
            label: 'Fill',
            description: 'Blocks while no field drives their color.',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-surface-2)',
          },
          {
            kind: 'color',
            id: 'diagram.outlineColor',
            label: 'Outline color',
            description: 'Block and group outlines.',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-border)',
          },
          {
            kind: 'color',
            id: 'diagram.groupColor',
            label: 'Group fill',
            default: null,
            placeholder: 'Default',
            swatch: 'rgb(115 140 179 / 0.1)',
          },
        ],
      },
      {
        id: 'diagram.ports',
        label: 'Ports',
        settings: [
          {
            kind: 'boolean',
            id: 'diagram.portLabels',
            label: 'Port names',
            default: true,
          },
          {
            kind: 'choice',
            id: 'diagram.portMarker',
            label: 'Marker',
            default: 'directional',
            options: [
              { value: 'directional', label: 'Directional' },
              { value: 'circle', label: 'Circle' },
              { value: 'diamond', label: 'Diamond' },
            ],
          },
          {
            kind: 'number',
            id: 'diagram.portSize',
            label: 'Marker size',
            description: 'Port markers, arrowheads, and junctions. They scale with zoom.',
            default: 8,
            min: 2,
            max: 24,
            step: 1,
          },
          {
            kind: 'number',
            id: 'diagram.portFontSize',
            label: 'Name size',
            description: 'Port name size. It scales with zoom.',
            keywords: ['font'],
            default: 11,
            min: 6,
            max: 24,
            step: 1,
          },
          {
            kind: 'number',
            id: 'diagram.portSpacing',
            label: 'Spacing',
            description: 'Distance between ports along a side.',
            default: 22,
            min: 8,
            max: 64,
            step: 1,
          },
        ],
      },
      {
        id: 'diagram.wires',
        label: 'Wires',
        settings: [
          {
            kind: 'choice',
            id: 'diagram.edges.route',
            label: 'Routing',
            keywords: ['orthogonal'],
            default: 'orthogonal',
            options: [
              { value: 'orthogonal', label: 'Right angles' },
              { value: 'straight', label: 'Straight' },
            ],
          },
          {
            kind: 'choice',
            id: 'diagram.edges.appearance',
            label: 'Style',
            description: 'Tag draws named tags at the ends instead of a line.',
            default: 'wire',
            options: [
              { value: 'wire', label: 'Wire' },
              { value: 'tag', label: 'Tag' },
            ],
          },
          {
            kind: 'boolean',
            id: 'diagram.edges.arrows',
            label: 'Arrowheads',
            description: 'Mark where each signal arrives.',
            default: true,
          },
          {
            kind: 'boolean',
            id: 'diagram.junctions',
            label: 'Junctions',
            description: 'Dot where three or more wire segments meet.',
            default: true,
          },
          {
            kind: 'number',
            id: 'diagram.edgeWidthPx',
            label: 'Width',
            description: 'Wire width while no field drives it.',
            default: 1.5,
            min: 0.25,
            max: 8,
            step: 0.25,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'diagram.routeClearance',
            label: 'Clearance',
            description: 'Gap wires keep from blocks.',
            default: 16,
            min: 1,
            max: 64,
            step: 1,
          },
          {
            kind: 'color',
            id: 'diagram.edgeColor',
            label: 'Color',
            description: 'Wires and ports while no field drives their color.',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-text-3)',
          },
        ],
      },
      {
        id: 'diagram.titles',
        label: 'Labels',
        settings: [
          {
            kind: 'boolean',
            id: 'diagram.labels.visible',
            label: 'Titles',
            description: 'Show block, wire and group titles.',
            default: true,
          },
          {
            kind: 'number',
            id: 'diagram.fontSizePx',
            label: 'Size',
            description: 'Title size. It scales with zoom.',
            keywords: ['font'],
            default: 12,
            min: 6,
            max: 32,
            step: 1,
          },
          {
            kind: 'number',
            id: 'diagram.labels.maxWidth',
            label: 'Width',
            description: 'Widest a title runs before it wraps or ends.',
            default: null,
            min: 16,
            max: 1024,
            step: 8,
            placeholder: 'No limit',
          },
          {
            kind: 'choice',
            id: 'diagram.labels.overflow',
            label: 'Overflow',
            default: 'ellipsis',
            options: [
              { value: 'ellipsis', label: 'Ellipsis' },
              { value: 'wrap', label: 'Wrap' },
            ],
          },
          {
            kind: 'text',
            id: 'diagram.font',
            label: 'Font',
            keywords: ['typeface'],
            default: '',
            placeholder: 'JetBrains Mono',
          },
          {
            kind: 'color',
            id: 'diagram.textColor',
            label: 'Color',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-text-1)',
          },
        ],
      },
      {
        id: 'diagram.layout',
        label: 'Layout',
        settings: [
          {
            kind: 'choice',
            id: 'diagram.layout.algorithm',
            label: 'Layout',
            description: 'Manual keeps the positions the model gives.',
            default: 'layered',
            options: [
              { value: 'layered', label: 'Layered' },
              { value: 'manual', label: 'Manual' },
            ],
          },
          {
            kind: 'choice',
            id: 'diagram.layout.direction',
            label: 'Direction',
            description: 'Where signals flow, rank to rank.',
            default: 'right',
            options: [
              { value: 'right', label: 'Right' },
              { value: 'left', label: 'Left' },
              { value: 'down', label: 'Down' },
              { value: 'up', label: 'Up' },
            ],
          },
          {
            kind: 'number',
            id: 'diagram.layout.vertexGap',
            label: 'Block gap',
            description: 'Space between blocks in a rank.',
            default: 24,
            min: 0,
            max: 128,
            step: 1,
          },
          {
            kind: 'number',
            id: 'diagram.layout.rankGap',
            label: 'Rank gap',
            description: 'Space between ranks. It grows to fit wire titles.',
            default: 64,
            min: 0,
            max: 256,
            step: 1,
          },
          {
            kind: 'number',
            id: 'diagram.layout.sweeps',
            label: 'Crossing passes',
            description: 'Passes spent untangling wires.',
            keywords: ['sweeps'],
            default: 4,
            min: 0,
            max: 12,
            step: 1,
          },
        ],
      },
      {
        id: 'diagram.highlight',
        label: 'Highlight',
        settings: [
          {
            kind: 'number',
            id: 'diagram.hoverWidthPx',
            label: 'Hover width',
            default: 3,
            min: 0,
            max: 16,
            step: 0.25,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'diagram.selectedWidthPx',
            label: 'Selection width',
            default: 3,
            min: 0,
            max: 16,
            step: 0.25,
            unit: 'px',
          },
          {
            kind: 'color',
            id: 'diagram.hoverColor',
            label: 'Hover color',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-focus-ring)',
          },
          {
            kind: 'color',
            id: 'diagram.selectedColor',
            label: 'Selection color',
            default: null,
            placeholder: 'Theme',
            swatch: 'var(--color-focus-ring)',
          },
        ],
      },
      {
        id: 'diagram.camera',
        label: 'Camera',
        settings: [
          {
            kind: 'number',
            id: 'diagram.animationMs',
            label: 'Easing',
            description: 'Duration of camera and block moves.',
            keywords: ['animation'],
            default: 300,
            min: 0,
            max: 2000,
            step: 50,
            unit: 'ms',
          },
          {
            kind: 'number',
            id: 'diagram.fitPaddingPx',
            label: 'Fit padding',
            description: 'Space kept around the diagram when it is fitted.',
            default: 32,
            min: 0,
            max: 200,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'diagram.revealPaddingPx',
            label: 'Reveal margin',
            description: 'How far inside the edge a located element must sit.',
            default: 48,
            min: 0,
            max: 200,
            step: 1,
            unit: 'px',
          },
        ],
      },
      {
        id: 'diagram.interaction',
        label: 'Interaction',
        settings: [
          {
            kind: 'choice',
            id: 'diagram.input.mode',
            label: 'Mode',
            description: 'Navigate moves the camera. Inspect only selects and opens menus.',
            keywords: ['input'],
            default: 'navigate',
            options: [
              { value: 'navigate', label: 'Navigate' },
              { value: 'inspect', label: 'Inspect' },
            ],
          },
          {
            kind: 'choice',
            id: 'diagram.input.wheel',
            label: 'Wheel zoom',
            description: 'When the wheel zooms the view.',
            keywords: ['scroll', 'mouse'],
            default: 'zoom',
            options: WHEEL,
          },
          {
            kind: 'boolean',
            id: 'diagram.input.keyboard',
            label: 'Keyboard',
            description: 'Pan, zoom, fit and step with the keys.',
            default: true,
          },
          {
            kind: 'number',
            id: 'diagram.pickRadiusPx',
            label: 'Pick radius',
            description: 'How near the pointer must be to hover or select.',
            default: 8,
            min: 0,
            max: 32,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'diagram.input.dragThresholdPx',
            label: 'Drag threshold',
            description: 'How far the mouse moves before a press becomes a drag.',
            default: 4,
            min: 0,
            max: 32,
            step: 1,
            unit: 'px',
          },
          {
            kind: 'number',
            id: 'diagram.input.touchDragThresholdPx',
            label: 'Touch drag threshold',
            description: 'How far a touch moves before it becomes a drag.',
            default: 8,
            min: 0,
            max: 48,
            step: 1,
            unit: 'px',
          },
        ],
      },
      {
        id: 'diagram.quality',
        label: 'Quality',
        settings: [
          {
            kind: 'choice',
            id: 'diagram.msaa',
            label: 'Antialiasing',
            description: 'Every shape already smooths its own edges; multisampling adds only cost.',
            keywords: ['msaa', 'multisample'],
            default: 1,
            options: MSAA,
          },
          {
            kind: 'choice',
            id: 'diagram.detail',
            label: 'Detail',
            description: 'Auto fades ports and arrowheads out as the view zooms out.',
            keywords: ['level of detail', 'lod'],
            default: 'auto',
            options: [
              { value: 'auto', label: 'Auto' },
              { value: 'full', label: 'Full' },
            ],
          },
          {
            kind: 'choice',
            id: 'diagram.hover',
            label: 'Hover search',
            description: 'Auto pauses it while the view moves or runs slow.',
            keywords: ['pick', 'performance'],
            default: 'auto',
            options: HOVER,
          },
          {
            kind: 'number',
            id: 'diagram.hoverBudgetMs',
            label: 'Hover budget',
            description: 'Time a hover search may take per frame.',
            keywords: ['performance'],
            default: 2,
            min: 0.5,
            max: 16,
            step: 0.5,
            unit: 'ms',
          },
          {
            kind: 'number',
            id: 'diagram.animationMaxVertices',
            label: 'Animation limit',
            description: 'Diagrams with more blocks than this skip animation.',
            keywords: ['performance'],
            default: 512,
            min: 0,
            max: 100000,
            step: 1,
          },
        ],
      },
    ],
  },
] as const satisfies readonly SettingsCategory[]

type Definition = (typeof SETTINGS)[number]['groups'][number]['settings'][number]
type ValueOf<D> = D extends { kind: 'choice'; options: readonly { value: infer V }[] }
  ? V
  : D extends { kind: 'boolean' }
    ? boolean
    : D extends { kind: 'number'; default: infer V }
      ? number | Extract<V, null>
      : D extends { kind: 'color' }
        ? string | null
        : string

export type SettingsValues = { [D in Definition as D['id']]: ValueOf<D> }
export type SettingKey = keyof SettingsValues
export type SettingsDocument = Partial<SettingsValues>
export interface SettingsReader {
  get<K extends SettingKey>(key: K): SettingsValues[K]
}

export const definitions: readonly Setting[] = (SETTINGS as readonly SettingsCategory[]).flatMap(
  (category) => category.groups.flatMap((group) => group.settings),
)
const byId = new Map(definitions.map((setting) => [setting.id, setting]))
export const defaults = Object.freeze(
  Object.fromEntries(definitions.map((setting) => [setting.id, setting.default])),
) as Readonly<SettingsValues>

/** Validate a whole change before committing any of it. */
export function validateSettings(input: unknown): SettingsDocument {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Settings must be a JSON object.')
  const result: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(input)) {
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
    result[key] = value as SettingValue
  }
  return result as SettingsDocument
}

export function reader(values: SettingsDocument = {}): SettingsReader {
  return { get: (key) => (key in values ? values[key]! : defaults[key]) }
}
