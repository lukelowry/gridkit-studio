/** Which times of a run a view holds when the whole run is too large. */

import type { Domain } from '@latkit/model'

/** Without `to`, the window is open-ended. */
export interface Held {
  readonly from: number
  readonly to?: number
}

/** `held` while it covers `need`, else `need` widened by `margin`. An `open` window has no end, so
 *  frames append to it; it restarts once `need` is three spans past its start, bounding memory. */
export function holdFor(held: Held | undefined, need: Domain, open: boolean, margin: number): Held {
  const span = need[1] - need[0]
  if (held && (held.to === undefined) === open && held.from <= need[0]) {
    if (held.to === undefined ? need[0] - held.from <= 3 * span : held.to >= need[1]) return held
  }
  return { from: need[0] - margin, ...(!open && { to: need[1] + margin }) }
}
