/** Build monitor traces and axes from the selected field, run, and theme. */

import type { Axis, Domain } from '@latkit/model'
import type { Monitor, MonitorConfig, MonitorLimits } from '@latkit/monitor'

import { defaults, type SettingsReader } from '../../preferences.js'
import type { Palette } from '../theme.js'
import { color } from '../theme.js'
/** A recorded field a plot draws: every row of its type, or the one `id` names. */
type Plotted = { type: string; field: string; id?: string }

/** Bounded plot caches; the application owns the complete run separately. */
export const PLOT_LIMITS: MonitorLimits = { historyBytes: 128 * 1024 ** 2 }

/** The plot's one trace, named once so that another field replaces it in place. */
const TRACE = 'plotted'

/** The margin past the axes, top, right, bottom, left: `--spacing-sm` above, `--spacing-md` to the
 *  right for the last time label's overhang, and none below or to the left, where the axes' own
 *  labels are the margin. */
const MARGIN_PX = [8, 12, 0, 0] as const

/** The trace of `plotted`: a line for each row of its type, or for the one row it names. */
export function tracesOf(
  settings: SettingsReader,
  { type, field, id }: Plotted,
): MonitorConfig['traces'] {
  const baseColor = color(settings.get('monitor.baseColor') ?? defaults['monitor.baseColor'])
  return {
    [TRACE]: {
      from: type,
      field,
      widthPx: settings.get('monitor.widthPx'),
      interpolation: settings.get('monitor.interpolation'),
      ...(id !== undefined && { rows: { kind: 'ids', ids: [id] } }),
      ...(baseColor !== null && { baseColor }),
    },
  }
}

/** The coordinates a run's plot spans: what it recorded and, while it grows, an end rounded up to a
 *  power of two of its span. The window widens a few times a run, each time drawing the history
 *  again, and never on a guess at how far the run will go. */
export function windowOf(range: Domain | null, growing: boolean): Domain {
  if (range === null) return [0, 1]
  const span = range[1] - range[0]
  return growing && span > 0 ? [range[0], range[0] + 2 ** Math.ceil(Math.log2(span))] : range
}

/** Plot styling follows the settings and theme, including explicit resets. */
export function plotOptions(
  s: SettingsReader,
  palette: Palette | null,
  font: string | null,
  axis: string,
  valueLabel: string,
): Parameters<Monitor['set']>[0] {
  const coordinatePrecision = s.get('monitor.coordinateAxis.precision')
  const valuePrecision = s.get('monitor.valueAxis.precision')
  return {
    fontSizePx: s.get('monitor.fontSizePx'),
    font: s.get('monitor.font') || font ? { family: s.get('monitor.font') || font! } : null,
    paddingPx: [...MARGIN_PX],
    coordinateAxis: s.get('monitor.coordinateAxis')
      ? {
          label: axis,
          grid: s.get('monitor.coordinateAxis.grid'),
          minSpacingPx: s.get('monitor.coordinateAxis.minSpacingPx'),
          format: s.get('monitor.coordinateAxis.format'),
          ...(coordinatePrecision !== null && { precision: coordinatePrecision }),
        }
      : false,
    valueAxis: s.get('monitor.valueAxis')
      ? {
          label: s.get('monitor.valueAxis.label') ? valueLabel : '',
          grid: s.get('monitor.valueAxis.grid'),
          minSpacingPx: s.get('monitor.valueAxis.minSpacingPx'),
          format: s.get('monitor.valueAxis.format'),
          ...(valuePrecision !== null && { precision: valuePrecision }),
        }
      : false,
    hover: s.get('monitor.hover'),
    hoverBudgetMs: s.get('monitor.hoverBudgetMs'),
    msaa: s.get('monitor.msaa'),
    pickRadiusPx: s.get('monitor.pickRadiusPx'),
    domainPadding: s.get('monitor.domainPadding'),
    animationMs: s.get('monitor.animationMs'),
    motion: s.get('accessibility.motion') === 'reduce' ? 'reduce' : 'auto',
    selectedWidthPx: s.get('monitor.selectedWidthPx'),
    unselectedAlpha: s.get('monitor.unselectedAlpha'),
    input: { mode: s.get('monitor.input.mode'), keyboard: s.get('monitor.input.keyboard') },
    background: color(s.get('monitor.background'), palette?.surface1),
    textColor: color(s.get('monitor.textColor'), palette?.text2),
    axisColor: color(s.get('monitor.axisColor'), palette?.border),
    gridColor: color(
      s.get('monitor.gridColor'),
      palette ? [palette.text3[0], palette.text3[1], palette.text3[2], 0.15] : null,
    ),
    cursorColor: color(s.get('monitor.cursorColor'), palette?.primaryText),
    selectedColor: color(s.get('monitor.selectedColor'), palette?.primaryText),
  }
}

/** Continuous time at a CSS canvas point of a plot drawn with `plotOptions`, whose area the monitor
 *  lays out inside the margin: the value labels take 7 em (64 px at least) at the left, and the time
 *  axis three lines below. Independent of trace proximity: exact-data picking cannot scrub. */
export function coordinateAt(
  point: readonly [number, number],
  width: number,
  height: number,
  window: Domain,
  style: Pick<MonitorConfig, 'fontSizePx' | 'coordinateAxis' | 'valueAxis'>,
): number | null {
  const [above, after, below, before] = MARGIN_PX
  const size = style.fontSizePx ?? defaults['monitor.fontSizePx']
  const labeled =
    typeof style.valueAxis === 'string' ? style.valueAxis : style.valueAxis && style.valueAxis.label
  const left = before + (style.valueAxis === false ? 0 : Math.max(64, size * 7))
  const right = width - after
  const top = above + (labeled ? size * 1.8 : 0)
  const bottom = height - below - (style.coordinateAxis === false ? 0 : size * 3)
  if (
    right <= left ||
    bottom <= top ||
    point[0] < left ||
    point[0] > right ||
    point[1] < top ||
    point[1] > bottom
  )
    return null
  return window[0] + ((point[0] - left) / (right - left)) * (window[1] - window[0])
}

/** The axis's name in sentence case, as the page shows names; the producer owns its meaning. */
export function axisName(axis: Axis | undefined): string {
  const name = axis?.name ?? 'Coordinate'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** The axis's name and unit, as the time axis is captioned. */
export function axisLabel(axis: Axis | undefined): string {
  return axis?.unit ? `${axisName(axis)} (${axis.unit})` : axisName(axis)
}
