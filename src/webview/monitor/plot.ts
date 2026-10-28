import type { Camera } from 'latkit'

import type { TimeRange } from '../../shared/data.js'
import type { Results } from '../../shared/messages.js'

export function monitorWindow(results: Results | undefined, chosen?: TimeRange): TimeRange {
  const range = chosen ?? results?.span ?? results?.domain ?? [0, 1]
  return range[0] < range[1] ? range : [range[0], range[0] + 1]
}
export function sameWindow(a: TimeRange | undefined, b: TimeRange | undefined): boolean {
  return a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1])
}

export interface PlotState {
  camera?: Camera
  range?: TimeRange | null
}
