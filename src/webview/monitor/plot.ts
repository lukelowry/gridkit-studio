import type { Camera } from 'latkit'

import type { FrameRequest, TimeRange } from '../../shared/data.js'
import type { Plot, Results } from '../../shared/messages.js'

/** How long a zoom, pan or resize rests before the plots read the samples it shows. */
export const SETTLE_MS = 120

export function monitorWindow(results: Results | undefined, chosen?: TimeRange): TimeRange {
  const range = chosen ?? results?.span ?? results?.domain ?? [0, 1]
  return range[0] < range[1] ? range : [range[0], range[0] + 1]
}
export function sameWindow(a: TimeRange | undefined, b: TimeRange | undefined): boolean {
  return a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1])
}

/** What `plot` reads of `results`: its frames over `range`, across `columns` device pixel columns. */
export const plotRequest = (
  results: Pick<Results, 'id'>,
  plot: Plot,
  range: TimeRange,
  columns: number,
): FrameRequest => ({
  results: results.id,
  table: plot.from,
  field: plot.field,
  ...(plot.id !== undefined ? { ids: [plot.id] } : {}),
  range,
  purpose: 'plot',
  columns,
})

/** How `plot` frames `range`: the times, over the values the plot was given, else those it shows. */
export const plotCamera = (plot: Plot, range: TimeRange): Camera => ({
  x: [...range],
  y: plot.range ? [...plot.range] : null,
})
