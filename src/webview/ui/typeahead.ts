/**
 * Typeahead for lists driven from the keyboard (Menu, Select): characters typed in quick
 * succession spell a prefix, and the cursor jumps to the next entry whose text starts with it.
 */

/** How long typing may pause before the prefix starts over. */
const PAUSE_MS = 500

/** The prefix spelled by recent keystrokes. */
export class Typeahead {
  #prefix = ''
  #timer: ReturnType<typeof setTimeout> | undefined

  /** Add a typed character (compared without case) and return the prefix so far. */
  type(key: string): string {
    this.#prefix += key.toLowerCase()
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => (this.#prefix = ''), PAUSE_MS)
    return this.#prefix
  }

  /** Start over now, and drop the pending timer. */
  reset(): void {
    this.#prefix = ''
    clearTimeout(this.#timer)
  }
}

/**
 * The first of `count` entries after index `from` whose lowercase `text` starts with `prefix`,
 * searching forward and wrapping around so `from` itself is tried last; -1 when none does. A `from`
 * of -1 starts the search at the first entry.
 */
export function nextMatch(
  count: number,
  from: number,
  prefix: string,
  text: (index: number) => string,
): number {
  for (let offset = 1; offset <= count; offset++) {
    const index = (from + offset) % count
    if (text(index).startsWith(prefix)) return index
  }
  return -1
}
