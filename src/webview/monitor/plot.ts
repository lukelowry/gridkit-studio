/** Plot options shared by the Monitor view and video export. */

import { colormaps } from '@latkit/gpu'
import {
  type Data,
  type Domain,
  itemKey,
  type Query,
  rowAt,
  rowCount,
  type Schema,
  selectRows,
} from '@latkit/model'
import type { Monitor } from '@latkit/monitor'

import type { Bindings } from '../../shared/bindings.js'
import { intersectRows, recordedSelection } from '../../shared/coverage.js'
import { defaults, type SettingsReader } from '../../shared/preferences.js'
import type { Results } from '../../shared/simulation.js'
import { UNLIMITED } from '../gpu.js'
import { color, type Palette, viewStyle } from '../theme.js'
/** A recorded field a plot draws: every row of its type, or the one `id` names. */
type Plotted = { type: string; field: string; id?: string }

/** The same physical rows drive drawing, selection, keyboard readings and export. */
export function plotRows(
  source: Data,
  results: Results | undefined,
  plot: Plotted,
): Query.Selection['rows'] {
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

/** No limit refuses a plot: every row of any case, and history the size of any canvas or export.
 *  With history unbounded, a plot keeps each of up to four colorings of its traces, so recoloring
 *  never draws its lines again. */
export const PLOT_LIMITS: Monitor.Limits = { rows: UNLIMITED, historyBytes: UNLIMITED }

/** The single trace key, so another field replaces the trace in place. */
const TRACE = 'plotted'

/** The selected element's trace, when the plot draws its row. Any selection fades the other lines,
 *  so one the plot does not draw would fade them all. */
export function traceSelection(
  source: Data,
  selected: string | undefined,
  type: string,
  rows?: Query.Selection['rows'],
): Monitor.Item[] {
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
const traceKey = (item: Monitor.Item): string => itemKey(item, item.trace ?? '')

/** Whether two selections hold the same trace rows, whichever readings found them. */
export function sameSelection(a: readonly Monitor.Item[], b: readonly Monitor.Item[]): boolean {
  return a.length === b.length && a.every((item, i) => traceKey(item) === traceKey(b[i]!))
}

/** Padding past the plot's frame [top, right, bottom, left]: `--spacing-sm`, `--spacing-md` for the
 *  last time label's overhang, and `--spacing-2xs` so the frame's bottom line is never clipped; the
 *  value labels pad the left. */
const MARGIN_PX = [8, 12, 4, 0] as const

/** How many traces `rows` of `type` draw. */
export function traceCount(source: Data, type: string, rows: Query.Selection['rows']): number {
  const table = source.tables[type]
  return table ? rowCount(selectRows(table, rows)) : 0
}

/** Whether the samples of `sampled` are those `plotted` draws: its field, for its one row or for
 *  every row. A plot added to the Monitor waits for the samples it asks for. */
export function holds(sampled: readonly Query.Selection[], { type, field, id }: Plotted): boolean {
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
  rows?: Query.Selection['rows'],
  results?: Results,
): Pick<Monitor.Config, 'traces'> {
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

/** Renderer options from the settings and theme; a null `palette` or `font` keeps the default. A plot
 *  is framed. Its time ticks are labelled only with `ticks`, as on the last of plots stacked over one
 *  time axis; `time` captions that axis and `caption` the values, where nothing else names them. */
export function plotOptions(
  s: SettingsReader,
  palette: Palette | null,
  font: string | null,
  { ticks, time, caption }: { ticks: boolean; time?: string; caption?: string },
): Partial<Monitor.Config> {
  const xPrecision = s.get('monitor.xAxis.precision')
  const yPrecision = s.get('monitor.yAxis.precision')
  return {
    ...viewStyle(s, 'monitor', font, {
      background: palette?.surface1,
      textColor: palette?.text2,
      selectedColor: palette?.primaryText,
    }),
    paddingPx: [...MARGIN_PX],
    outline: true,
    xAxis: s.get('monitor.xAxis.visible')
      ? {
          label: ticks ? (time ?? '') : '',
          tickLabels: ticks,
          grid: s.get('monitor.xAxis.grid'),
          minSpacingPx: s.get('monitor.xAxis.minSpacingPx'),
          format: s.get('monitor.xAxis.format'),
          ...(xPrecision !== null && { precision: xPrecision }),
        }
      : false,
    yAxis: s.get('monitor.yAxis.visible')
      ? {
          label: caption ?? '',
          grid: s.get('monitor.yAxis.grid'),
          minSpacingPx: s.get('monitor.yAxis.minSpacingPx'),
          format: s.get('monitor.yAxis.format'),
          ...(yPrecision !== null && { precision: yPrecision }),
        }
      : false,
    traceColor: color(s.get('monitor.traceColor') ?? defaults['monitor.traceColor']),
    traceWidthPx: s.get('monitor.traceWidthPx'),
    unselectedAlpha: s.get('monitor.unselectedAlpha'),
    input: { mode: s.get('monitor.input.mode'), keyboard: s.get('monitor.input.keyboard') },
    axisColor: color(s.get('monitor.axisColor'), palette?.border),
    gridColor: color(
      s.get('monitor.gridColor'),
      palette ? [palette.text2[0], palette.text2[1], palette.text2[2], 0.15] : undefined,
    ),
    cursorColor: color(s.get('monitor.cursorColor'), palette?.primaryText),
    // The hovered reading's dot, as the playhead and the selection draw.
    hoverColor: palette?.primaryText,
  }
}

/** The axis name in sentence case; 'Coordinate' when unnamed. */
export function axisName(axis: Schema.Axis | undefined): string {
  const name = axis?.name ?? 'Coordinate'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** The axis caption: its name, then its unit in parentheses. */
export function axisLabel(axis: Schema.Axis | undefined): string {
  return axis?.unit ? `${axisName(axis)} (${axis.unit})` : axisName(axis)
}
