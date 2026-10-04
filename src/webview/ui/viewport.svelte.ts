/** Reactive list window measured from CSS row height. Offsets start at the first row. */

import { centerOffset, revealOffset, windowSize, windowStart } from './windowing.js'

export class Viewport {
  readonly #overscan: number
  #scroller: HTMLElement | null = null

  /** How far the rows are scrolled. */
  scrollTop = $state(0)
  /** The height the rows show in. */
  height = $state(0)
  /** One row's height. */
  rowHeight = $state(0)

  /** The first row to mount. */
  readonly first = $derived.by(() => windowStart(this.scrollTop, this.rowHeight, this.#overscan))
  /** How many rows to mount from `first`. */
  readonly count = $derived.by(() => windowSize(this.height, this.rowHeight, this.#overscan))

  /** A window mounting `overscan` rows beyond each end of the view, sized by the guesses given
   *  until the page is measured. */
  constructor(overscan: number, guess: { readonly rowHeight: number; readonly height: number }) {
    this.#overscan = overscan
    this.rowHeight = guess.rowHeight
    this.height = guess.height
  }

  /**
   * Follow `scroller`, the element the rows scroll in: its offset as it scrolls, and the sizes of
   * `probe` (an empty element one row tall) and of the view, less `header` (a sticky head above the
   * rows) where there is one. A size of zero (an element not laid out) keeps the last one. Returns
   * the function that stops following.
   */
  follow(scroller: HTMLElement, probe: HTMLElement, header?: HTMLElement): () => void {
    this.#scroller = scroller
    const measure = (): void => {
      const row = probe.getBoundingClientRect().height
      const view = scroller.clientHeight - (header?.offsetHeight ?? 0)
      if (row > 0) this.rowHeight = row
      if (view > 0) this.height = view
    }
    const scrolled = (): void => {
      this.scrollTop = scroller.scrollTop
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const element of [scroller, probe, header]) if (element) observer.observe(element)
    scroller.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', scrolled)
      if (this.#scroller === scroller) this.#scroller = null
    }
  }

  /** Scroll so the band `[top, top + height)` shows, moving as little as possible, or centered in the
   *  view when `center`. The band may lie beyond the rows mounted. */
  reveal(top: number, height: number, center = false): void {
    const scroller = this.#scroller
    if (scroller === null) return
    scroller.scrollTop = center
      ? centerOffset(this.height, top, height)
      : revealOffset(scroller.scrollTop, this.height, top, height)
    this.scrollTop = scroller.scrollTop
  }

  /** Back to the first row. */
  rewind(): void {
    if (this.#scroller !== null) this.#scroller.scrollTop = 0
    this.scrollTop = 0
  }

  /** Scroll to `offset`, as when a position is restored. */
  scrollTo(offset: number): void {
    if (this.#scroller !== null) this.#scroller.scrollTop = offset
    this.scrollTop = this.#scroller?.scrollTop ?? offset
  }
}
