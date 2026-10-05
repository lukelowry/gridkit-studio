/** Fixed-height list windowing; offsets are pixels from the first row. */

/** The first row to mount: the first in view, less `overscan`. */
export function windowStart(scrollTop: number, rowHeight: number, overscan: number): number {
  return Math.max(Math.floor(scrollTop / rowHeight) - overscan, 0)
}

/** How many rows to mount: enough to fill `viewport` (one row even unmeasured), plus `overscan`
 *  above and below. */
export function windowSize(viewport: number, rowHeight: number, overscan: number): number {
  return Math.ceil(Math.max(viewport, 1) / rowHeight) + 2 * overscan
}

/** The scroll offset that shows the band `[top, top + height)` with the least movement: unchanged
 *  when it already shows, else aligned to the edge it crossed. */
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

/** The scroll offset that centers the band `[top, top + height)`, never below 0. */
export function centerOffset(viewport: number, top: number, height: number): number {
  return Math.max(top - (viewport - height) / 2, 0)
}
