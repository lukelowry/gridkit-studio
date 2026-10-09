/** Plot options shared by the Monitor view and video export. */

import { colormaps } from '@latkit/gpu'
import {
  type Axis,
  type Data,
  type Domain,
  type FieldSelection,
  itemKey,
  rowAt,
  selectRows,
} from '@latkit/model'
import type { MonitorConfig, MonitorItem, MonitorLimits } from '@latkit/monitor'

import type { Bindings } from '../../shared/bindings.js'
import { intersectRows, recordedSelection } from '../../shared/coverage.js'
import { defaults, type SettingsReader } from '../../shared/preferences.js'
import type { Results } from '../../shared/simulation.js'
import { color, type Palette } from '../theme.js'
/** A recorded field a plot draws: every row of its type, or the one `id` names. */
type Plotted = { type: string; field: string; id?: string }

/** The same physical rows drive drawing, selection, keyboard readings and export. */
export function plotRows(
  source: Data,
  results: Results | undefined,
  plot: Plotted,
): FieldSelection['rows'] {
  const recorded = recordedSelection(source, results?.outputs ?? [], plot.type, plot.field)
  if (!plot.id) return recorded
  const table = source.tables[plot.type]!
  return {
    ...intersectRows(
      selectRows(table, recorded),
      selectRows(table, { kind: 'ids', ids: [plot.id] }),
    ),
    index: table.index,
  }
}

/** Caps each plot's history textures; the complete results are held outside the plot. */
export const PLOT_LIMITS: MonitorLimits = { historyBytes: 128 * 1024 ** 2 }

/** The single trace key, so another field replaces the trace in place. */
const TRACE = 'plotted'

/** The selected element's trace, when the plot draws its row. Any selection fades the other lines,
 *  so one the plot does not draw would fade them all. */
export function traceSelection(
  source: Data,
  selected: string | undefined,
  type: string,
  rows?: FieldSelection['rows'],
): MonitorItem[] {
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
    return included ? [{ source, index: table.index, row, trace: TRACE }] : []
  } catch {
    return []
  }
}

/** A trace row's identity, as the plot selects by it: the reading's frame is not part of it. */
const traceKey = (item: MonitorItem): string => itemKey(item, item.trace ?? '')

/** Whether two selections hold the same trace rows, whichever readings found them. */
export function sameSelection(a: readonly MonitorItem[], b: readonly MonitorItem[]): boolean {
  return a.length === b.length && a.every((item, i) => traceKey(item) === traceKey(b[i]!))
}

/** Padding past the axes [top, right, bottom, left]: `--spacing-sm`, then `--spacing-md` for the
 *  last time label's overhang; the axis labels pad the bottom and left. */
const MARGIN_PX = [8, 12, 0, 0] as const

/** Whether the samples of `sampled` are those `plotted` draws: its field, for its one row or for
 *  every row. A plot added to the Monitor waits for the samples it asks for. */
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
 *  network colors is colored the same way, by the value each line plots: its colormap, over the same
 *  range. The plot keeps only where lines lie and colors them as it draws, so a new range or
 *  colormap draws no line again. */
export function plotBindings(
  settings: SettingsReader,
  { type, field, id }: Plotted,
  bindings: Bindings = {},
  rows?: FieldSelection['rows'],
  results?: Results,
): Pick<MonitorConfig, 'traces'> {
  const mapped = [bindings.vertexColor, bindings.edgeColor].find(
    (binding) => binding?.type === type && binding.field === field,
  )
  // The whole range of the results, measured as they were read: the plot never reads it.
  const domain = mapped?.domain ?? results?.domains?.[type]?.[field]
  return {
    traces: {
      [TRACE]: {
        from: type,
        y: field,
        interpolation: settings.get('monitor.interpolation'),
        ...(mapped &&
          domain && {
            color: { field, domain, colormap: colormaps[settings.get('network.colormap')] },
          }),
        ...(rows
          ? { rows }
          : id !== undefined
            ? { rows: { kind: 'ids' as const, ids: [id] } }
            : {}),
      },
    },
  }
}

/** A simulation's interval, to its solver file's end time, stays fixed, including before its first
 * sample and after cancellation. Opened results use their recorded interval. */
export function monitorWindow(results?: Pick<Results, 'span' | 'domain'>, chosen?: Domain): Domain {
  if (chosen) return chosen
  const range = results?.span ?? results?.domain
  return range && range[1] > range[0] ? range : [range?.[0] ?? 0, (range?.[0] ?? 0) + 1]
}

/** Renderer options from the settings and theme; a null `palette` or `font` keeps the default. */
export function plotOptions(
  s: SettingsReader,
  palette: Palette | null,
  font: string | null,
  axis: string,
  valueLabel: string,
): Partial<MonitorConfig> {
  const xPrecision = s.get('monitor.xAxis.precision')
  const yPrecision = s.get('monitor.yAxis.precision')
  const family = s.get('monitor.font') || font
  const motion = s.get('accessibility.motion')
  return {
    fontSizePx: s.get('monitor.fontSizePx'),
    ...(family && { font: { family } }),
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
      palette ? [palette.text2[0], palette.text2[1], palette.text2[2], 0.15] : undefined,
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
