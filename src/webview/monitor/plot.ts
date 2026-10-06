/** Plot options shared by the Monitor view and video export. */

import { colormaps } from '@latkit/gpu'
import {
  type Axis,
  type Data,
  type Domain,
  type FieldSelection,
  type Item,
  rowAt,
  selectRows,
} from '@latkit/model'
import type { Monitor, MonitorConfig, MonitorLimits } from '@latkit/monitor'

import type { Bindings } from '../../shared/bindings.js'
import { defaults, type SettingsReader } from '../../shared/preferences.js'
import type { SimulationInfo } from '../../shared/simulation.js'
import { color, type Palette } from '../theme.js'
/** A recorded field a plot draws: every row of its type, or the one `id` names. */
type Plotted = { type: string; field: string; id?: string }

/** Caps each plot's history textures; the complete run is held outside the plot. */
export const PLOT_LIMITS: MonitorLimits = { historyBytes: 128 * 1024 ** 2 }

/** The single trace key, so another field replaces the trace in place. */
const TRACE = 'plotted'

/** Highlight only a displayed row. The renderer's focus query otherwise overrides trace rows. */
export function traceSelection(
  source: Data,
  selected: string | undefined,
  type: string,
  rows?: FieldSelection['rows'],
): Item[] {
  if (!selected?.startsWith(type + '/')) return []
  const table = source.tables[type]
  if (!table) return []
  try {
    const row = rowAt(selectRows(table, { kind: 'ids', ids: [selected] }), 0)
    const available = selectRows(table, rows)
    const included =
      available.kind === 'range'
        ? row >= available.offset && row < available.offset + available.count
        : available.values.includes(row)
    return included ? [{ source, index: table.index, row }] : []
  } catch {
    return []
  }
}

/** Padding past the axes [top, right, bottom, left]: `--spacing-sm`, then `--spacing-md` for the
 *  last time label's overhang; the axis labels pad the bottom and left. */
const MARGIN_PX = [8, 12, 0, 0] as const

/** Whether the samples of `sampled` are those `plotted` draws: its field, for its one row or for
 *  every row. A plot added to the Monitor waits for the stream that holds them. */
export function holds(sampled: readonly FieldSelection[], { type, field, id }: Plotted): boolean {
  return sampled.some(
    ({ from, select, rows }) =>
      from === type &&
      select.includes(field) &&
      (rows === undefined || (id !== undefined && rows.kind === 'ids' && rows.ids.includes(id))),
  )
}

/** Whether two windows are equal; two absent ones are. */
export const sameWindow = (a: Domain | undefined, b: Domain | undefined): boolean =>
  a?.[0] === b?.[0] && a?.[1] === b?.[1]

/** The trace of `plotted`: a line for each row of its type, or for the one row it names. A field the
 *  network colors is colored the same way: its colormap, over the same range. */
export function plotBindings(
  settings: SettingsReader,
  { type, field, id }: Plotted,
  bindings: Bindings = {},
  rows?: FieldSelection['rows'],
  run?: SimulationInfo,
): Pick<MonitorConfig, 'traces' | 'valueColor'> {
  const mapped = [bindings.vertexColor, bindings.edgeColor].find(
    (binding) => binding?.type === type && binding.field === field,
  )
  const domain = mapped?.domain ?? run?.domains?.[type]?.[field]
  const colormap = colormaps[settings.get('network.colormap')]
  // Same-value color is applied to cached coverage. Explicit global ranges never become
  // trace bindings, so new live extrema cannot invalidate the history or append fast path.
  return {
    valueColor: mapped && domain ? { domain, colormap } : null,
    traces: {
      [TRACE]: {
        from: type,
        y: field,
        interpolation: settings.get('monitor.interpolation'),
        ...(id !== undefined
          ? { rows: { kind: 'ids' as const, ids: [id] } }
          : rows
            ? { rows }
            : {}),
      },
    },
  }
}

/** A simulation's configured interval stays fixed, including before its first sample and
 * after cancellation. Imported recordings use their recorded interval. */
export function monitorWindow(
  run?: Pick<SimulationInfo, 'span' | 'domain'>,
  chosen?: Domain,
): Domain {
  if (chosen) return chosen
  const range = run?.span ?? run?.domain
  return range && range[1] > range[0] ? range : [range?.[0] ?? 0, (range?.[0] ?? 0) + 1]
}

/** Renderer options from the settings and theme; a null `palette` or `font` keeps the default. */
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
  const motion = s.get('accessibility.motion')
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
    animationMs: s.get('monitor.animationMs'),
    fitPaddingPx: s.get('monitor.fitPaddingPx'),
    motion: motion === 'system' ? 'auto' : motion,
    selectedWidthPx: s.get('monitor.selectedWidthPx'),
    unselectedAlpha: s.get('monitor.unselectedAlpha'),
    input: { mode: s.get('monitor.input.mode'), keyboard: s.get('monitor.input.keyboard') },
    background: color(s.get('monitor.background'), palette?.surface1),
    textColor: color(s.get('monitor.textColor'), palette?.text2),
    axisColor: color(s.get('monitor.axisColor'), palette?.border),
    gridColor: color(
      s.get('monitor.gridColor'),
      palette ? [palette.text2[0], palette.text2[1], palette.text2[2], 0.15] : null,
    ),
    cursorColor: color(s.get('monitor.cursorColor'), palette?.primaryText),
    selectedColor: color(s.get('monitor.selectedColor'), palette?.primaryText),
  }
}

/** The axis name in sentence case; 'Coordinate' when unnamed. */
export function axisName(axis: Axis | undefined): string {
  const name = axis?.name ?? 'Coordinate'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** The axis caption: its name, then its unit in parentheses. */
export function axisLabel(axis: Axis | undefined): string {
  return axis?.unit ? `${axisName(axis)} (${axis.unit})` : axisName(axis)
}
