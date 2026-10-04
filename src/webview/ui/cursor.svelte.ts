/** Shared keyboard navigation and typeahead. Space selects rather than contributing to typeahead. */

import { nextMatch, Typeahead } from './typeahead.js'

/** What a cursor moves over. */
interface CursorOptions {
  /** How many entries there are now. */
  readonly count: () => number
  /** An entry's lowercase text, for typeahead; without it, characters do not move the cursor. */
  readonly text?: (index: number) => string
  /** Arrows wrap around at the ends. */
  readonly wrap?: boolean
}

export class ListCursor {
  /** The active entry's index, or -1 before there is one. */
  active = $state(-1)

  readonly #count: () => number
  readonly #text: ((index: number) => string) | undefined
  readonly #wrap: boolean
  readonly #typeahead = new Typeahead()

  constructor({ count, text, wrap = false }: CursorOptions) {
    this.#count = count
    this.#text = text
    this.#wrap = wrap
  }

  /** Move for `event`'s key, `page` entries at a time for Page Up and Page Down. True when the key is
   *  the cursor's (the caller then prevents its default), even when there was nowhere to go. */
  key(event: KeyboardEvent, page = 1): boolean {
    const count = this.#count()
    if (count === 0) return false
    const to = this.#target(event, count, page)
    if (to === null) return false
    this.active = to
    return true
  }

  /** Forget the active entry and any prefix being typed. */
  reset(): void {
    this.active = -1
    this.#typeahead.reset()
  }

  #target(event: KeyboardEvent, count: number, page: number): number | null {
    const at = this.active
    const last = count - 1
    switch (event.key) {
      case 'ArrowDown':
        return this.#wrap ? (at + 1) % count : Math.min(at + 1, last)
      case 'ArrowUp':
        if (this.#wrap) return (Math.max(at, 0) - 1 + count) % count
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
    const typed =
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    if (!typed || this.#text === undefined) return null
    const found = nextMatch(count, at, this.#typeahead.type(event.key), this.#text)
    return found < 0 ? at : found
  }
}
