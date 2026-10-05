/** Typeahead: quick keystrokes spell a prefix, and the cursor jumps to the next entry with it. */

/** How long typing may pause before the prefix restarts. */
const PAUSE_MS = 500

export class Typeahead {
  #prefix = ''
  #timer: ReturnType<typeof setTimeout> | undefined

  /** Add a key, case-folded, and return the prefix so far. */
  type(key: string): string {
    this.#prefix += key.toLowerCase()
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => (this.#prefix = ''), PAUSE_MS)
    return this.#prefix
  }

  /** Clear the prefix and its pending timer. */
  reset(): void {
    this.#prefix = ''
    clearTimeout(this.#timer)
  }
}

/**
 * The first of `count` entries after `from` whose lowercase `text` starts with `prefix`, wrapping
 * so `from` is tried last; -1 when none. A `from` of -1 starts at the first entry.
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
