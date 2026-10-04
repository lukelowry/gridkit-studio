/** Fixed-height list window calculations; offsets are pixels from the first row. */

/** The first row to mount: the first row in view, less `overscan` rows above it. */
export function windowStart(scrollTop: number, rowHeight: number, overscan: number): number {
  return Math.max(Math.floor(scrollTop / rowHeight) - overscan, 0)
}

/** How many rows to mount: enough to fill `viewport` (at least one row, even unmeasured), plus
 *  `overscan` rows above and below. */
export function windowSize(viewport: number, rowHeight: number, overscan: number): number {
  return Math.ceil(Math.max(viewport, 1) / rowHeight) + 2 * overscan
}

/** The scroll offset that shows the band `[top, top + height)` in a `viewport`, moving as little as
 *  possible: unchanged when the band already shows, else aligning the edge it crossed. */
export function revealOffset(
  scrollTop: number,
  viewport: number,
  top: number,
  height: number,
): number {
  if (top < scrollTop) return top
  const bottom = top + height
  return bottom > scrollTop + viewport ? bottom - viewport : scrollTop
}

/** The scroll offset that centers the band `[top, top + height)` in a `viewport`, never below 0. */
export function centerOffset(viewport: number, top: number, height: number): number {
  return Math.max(top - (viewport - height) / 2, 0)
}
