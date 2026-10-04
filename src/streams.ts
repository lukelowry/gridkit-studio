/** How much of a run a view holds when the whole of it is too much to hold. */

import type { Domain } from '@latkit/model'

/** The times of a run a view holds: from `from` on, to `to` when it ends there. */
export interface Held {
  from: number
  to?: number
}

/**
 * The window of a run a view holds to show the times it needs: what it `held` already while that
 * covers `need`, or else the need with `margin` either side. An `open` window has no end, so the
 * frames a run adds are appended to it; it is let go once the need has moved three of its spans
 * past the window's start, so a long run does not pile up behind the view.
 */
export function holdFor(held: Held | undefined, need: Domain, open: boolean, margin: number): Held {
  const span = need[1] - need[0]
  if (held && (held.to === undefined) === open && held.from <= need[0]) {
    if (held.to === undefined ? need[0] - held.from <= 3 * span : held.to >= need[1]) return held
  }
  return { from: need[0] - margin, ...(!open && { to: need[1] + margin }) }
}
