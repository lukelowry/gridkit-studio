/** A reactive window over fixed-height rows, sized from the page. */

import { centerOffset, revealOffset, windowSize, windowStart } from './windowing.js'

export class Viewport {
  readonly #overscan: number
  #scroller: HTMLElement | null = null

  scrollTop = $state(0)
  /** The visible height. */
  height = $state(0)
  rowHeight = $state(0)

  /** The first row to mount. */
  readonly first = $derived.by(() => windowStart(this.scrollTop, this.rowHeight, this.#overscan))
  /** How many rows to mount from `first`. */
  readonly count = $derived.by(() => windowSize(this.height, this.rowHeight, this.#overscan))

  /** Mount `overscan` rows past each end of the view; `guess` sizes the window until measured. */
  constructor(overscan: number, guess: { readonly rowHeight: number; readonly height: number }) {
    this.#overscan = overscan
    this.rowHeight = guess.rowHeight
    this.height = guess.height
  }

  /**
   * Track `scroller`'s offset and height, and a row's height from `probe`, an empty element one row
   * tall. A zero size (not laid out) keeps the last. Returns the function that stops tracking.
   */
  follow(scroller: HTMLElement, probe: HTMLElement): () => void {
    this.#scroller = scroller
    const measure = (): void => {
      const row = probe.getBoundingClientRect().height
      const view = scroller.clientHeight
      if (row > 0) this.rowHeight = row
      if (view > 0) this.height = view
    }
    const scrolled = (): void => {
      this.scrollTop = scroller.scrollTop
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(probe)
    scroller.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', scrolled)
      if (this.#scroller === scroller) this.#scroller = null
    }
  }

  /** Scroll the band `[top, top + height)` into view with the least movement, or centered. The band
   *  need not be mounted. */
  reveal(top: number, height: number, center = false): void {
    const scroller = this.#scroller
    if (scroller === null) return
    scroller.scrollTop = center
      ? centerOffset(this.height, top, height)
      : revealOffset(scroller.scrollTop, this.height, top, height)
    this.scrollTop = scroller.scrollTop
  }

  rewind(): void {
    if (this.#scroller !== null) this.#scroller.scrollTop = 0
    this.scrollTop = 0
  }
}
