import type { Camera } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { Monitor, Results } from '../../shared/messages.js'

/** How long a zoom or pan must settle before the Monitor reports its window. */
export const SETTLE_MS = 120

export function monitorWindow(results: Results | undefined, chosen?: TimeRange): TimeRange {
  const range = chosen ?? results?.span ?? results?.domain ?? [0, 1]
  return range[0] < range[1] ? range : [range[0], range[0] + 1]
}
export function sameWindow(a: TimeRange | undefined, b: TimeRange | undefined): boolean {
  return a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1])
}

/** The camera over `range`: the monitor's fixed value range if set, else a fit to its values. */
export const plotCamera = (monitor: Monitor, range: TimeRange): Camera => ({
  x: [...range],
  y: monitor.range ? [...monitor.range] : null,
})
