/** Build monitor traces and axes from the selected field, run, and theme. */

import type { Axis, Domain } from '@latkit/model'
import type { Monitor, MonitorConfig, MonitorLimits } from '@latkit/monitor'

import { defaults, type SettingsReader } from '../../shared/preferences.js'
import { color, type Palette } from '../theme.js'
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
  return {
    [TRACE]: {
      from: type,
      y: field,
      interpolation: settings.get('monitor.interpolation'),
      ...(id !== undefined && { rows: { kind: 'ids', ids: [id] } }),
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

/** Plot styling follows the settings and theme; null leaves an option to the renderer. */
export function plotOptions(
  s: SettingsReader,
  palette: Palette | null,
  font: string | null,
  axis: string,
  valueLabel: string,
): Parameters<Monitor['set']>[0] {
  const xPrecision = s.get('monitor.xAxis.precision')
  const yPrecision = s.get('monitor.yAxis.precision')
  const family = s.get('monitor.font') || font
  return {
    fontSizePx: s.get('monitor.fontSizePx'),
    font: family ? { family } : null,
    paddingPx: [...MARGIN_PX],
    xAxis: s.get('monitor.xAxis.visible')
      ? {
          label: axis,
          grid: s.get('monitor.xAxis.grid'),
          minSpacingPx: s.get('monitor.xAxis.minSpacingPx'),
          format: s.get('monitor.xAxis.format'),
          ...(xPrecision !== null && { precision: xPrecision }),
        }
      : false,
    yAxis: s.get('monitor.yAxis.visible')
      ? {
          label: s.get('monitor.yAxis.label') ? valueLabel : '',
          grid: s.get('monitor.yAxis.grid'),
          minSpacingPx: s.get('monitor.yAxis.minSpacingPx'),
          format: s.get('monitor.yAxis.format'),
          ...(yPrecision !== null && { precision: yPrecision }),
        }
      : false,
    traceColor: color(s.get('monitor.traceColor') ?? defaults['monitor.traceColor']),
    traceWidthPx: s.get('monitor.traceWidthPx'),
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

/** The axis's name in sentence case, as the page shows names; the producer owns its meaning. */
export function axisName(axis: Axis | undefined): string {
  const name = axis?.name ?? 'Coordinate'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** The axis's name and unit, as the time axis is captioned. */
export function axisLabel(axis: Axis | undefined): string {
  return axis?.unit ? `${axisName(axis)} (${axis.unit})` : axisName(axis)
}
