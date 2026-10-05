/** Keyboard movement through a list, with typeahead. */

import { nextMatch, Typeahead } from './typeahead.js'

interface CursorOptions {
  readonly count: () => number
  /** An entry's lowercase text, for typeahead. */
  readonly text: (index: number) => string
}

export class ListCursor {
  /** The active entry's index, or -1 for none. */
  active = $state(-1)

  readonly #count: () => number
  readonly #text: (index: number) => string
  readonly #typeahead = new Typeahead()

  constructor({ count, text }: CursorOptions) {
    this.#count = count
    this.#text = text
  }

  /** Move for `event`'s key, `page` entries per Page Up or Down. True when the key is the cursor's,
   *  even with nowhere to go, so the caller prevents its default. */
  key(event: KeyboardEvent, page: number): boolean {
    const count = this.#count()
    if (count === 0) return false
    const to = this.#target(event, count, page)
    if (to === null) return false
    this.active = to
    return true
  }

  /** Clear the active entry and the typed prefix. */
  reset(): void {
    this.active = -1
    this.#typeahead.reset()
  }

  #target(event: KeyboardEvent, count: number, page: number): number | null {
    const at = this.active
    const last = count - 1
    switch (event.key) {
      case 'ArrowDown':
        return Math.min(at + 1, last)
      case 'ArrowUp':
        return at < 0 ? last : Math.max(at - 1, 0)
      case 'PageDown':
        return Math.min(Math.max(at, 0) + page, last)
      case 'PageUp':
        return Math.max(at - page, 0)
      case 'Home':
        return 0
      case 'End':
        return last
    }
    // Space selects, so it never joins the prefix.
    const typed =
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    if (!typed) return null
    const found = nextMatch(count, at, this.#typeahead.type(event.key), this.#text)
    return found < 0 ? at : found
  }
}
