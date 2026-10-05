/** The Select listbox model: options indexed, filtered into grouped slots, windowed into runs. */

export interface SelectOption<T> {
  readonly value: T
  readonly label: string
  /** The heading it sits under; groups keep the order they first appear in. */
  readonly group?: string
}

/** An option, or the clear row (`value` and `key` null), with its label lowercased for matching. */
interface Entry<T> {
  readonly value: T | null
  readonly key: string | null
  readonly label: string
  readonly text: string
}

/** The options by key, and their entries by heading ('' for none) in first-appearance order. */
interface OptionIndex<T> {
  readonly byKey: ReadonlyMap<string, SelectOption<T>>
  readonly groups: readonly (readonly [heading: string, entries: readonly Entry<T>[]])[]
}

/** The rows under one heading ('' for none), in slots `[start, end)` with the heading's own. */
export interface OptionGroup {
  readonly label: string
  readonly start: number
  readonly end: number
  /** The ARIA set size: the group's rows, or every row under no heading together. */
  readonly setsize: number
}

export interface OptionRow<T> extends Entry<T> {
  readonly group: OptionGroup
  /** Layout position; every row and every named heading takes one slot. */
  readonly slot: number
  /** Keyboard position. */
  readonly nav: number
  /** 1-based position in its ARIA set. */
  readonly posinset: number
}

interface OptionLayout<T> {
  /** Named headings and rows in layout order; the count sets the scroll height. */
  readonly slots: readonly (OptionGroup | OptionRow<T>)[]
  /** Rows in keyboard order. */
  readonly nav: readonly OptionRow<T>[]
  /** Keyboard position by key (null for the clear row). */
  readonly navOf: ReadonlyMap<string | null, number>
}

/** Consecutive rows of one group, as a window mounts them. */
interface OptionRun<T> {
  readonly group: OptionGroup
  readonly rows: OptionRow<T>[]
}

/** Index `options` by `key`, lowercasing labels once for every query. */
export function indexOptions<T>(
  options: readonly SelectOption<T>[],
  key: (value: T) => string = String,
): OptionIndex<T> {
  const byKey = new Map<string, SelectOption<T>>()
  const grouped = new Map<string, Entry<T>[]>()
  for (const option of options) {
    const text = key(option.value)
    byKey.set(text, option)
    const heading = option.group ?? ''
    let group = grouped.get(heading)
    if (group === undefined) {
      group = []
      grouped.set(heading, group)
    }
    // Only labels are searched: a value is opaque data, not text.
    group.push({
      value: option.value,
      key: text,
      label: option.label,
      text: option.label.toLowerCase(),
    })
  }
  return { byKey, groups: [...grouped.entries()] }
}

/**
 * Lay out, group by group, the options whose label contains every word of `query` in any case. A
 * `clear` label leads as the clear row only while there is no query; groups left empty vanish.
 */
export function layoutOptions<T>(
  index: OptionIndex<T>,
  clear: string | null,
  query = '',
): OptionLayout<T> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
  const slots: (OptionGroup | OptionRow<T>)[] = []
  const nav: OptionRow<T>[] = []
  const navOf = new Map<string | null, number>()
  // Rows under no heading form one ARIA set, sized once every group is placed.
  const headless: { setsize: number }[] = []
  let loose = 0

  // Runs over every option on each keystroke, so a plain loop.
  const matches = (entry: Entry<T>): boolean => {
    for (let at = 0; at < words.length; at++) if (!entry.text.includes(words[at]!)) return false
    return true
  }

  const place = (label: string, entries: readonly Entry<T>[]): void => {
    if (entries.length === 0) return
    const named = label !== ''
    const start = slots.length
    const group = {
      label,
      start,
      end: start + (named ? 1 : 0) + entries.length,
      setsize: entries.length,
    }
    if (named) slots.push(group)
    else headless.push(group)
    for (let position = 0; position < entries.length; position++) {
      const row: OptionRow<T> = {
        ...entries[position]!,
        group,
        slot: slots.length,
        nav: nav.length,
        posinset: named ? position + 1 : ++loose,
      }
      slots.push(row)
      navOf.set(row.key, row.nav)
      nav.push(row)
    }
  }

  if (clear !== null && words.length === 0) {
    place('', [{ value: null, key: null, label: clear, text: clear.toLowerCase() }])
  }
  for (const [heading, entries] of index.groups)
    place(heading, words.length === 0 ? entries : entries.filter(matches))
  for (const group of headless) group.setsize = loose
  return { slots, nav, navOf }
}

/**
 * The rows in slots `[first, first + count)` split into runs by group, plus `pinned` (the active
 * row) wherever it lies beyond them, so aria-activedescendant always names a mounted row.
 */
export function windowRuns<T>(
  layout: OptionLayout<T>,
  first: number,
  count: number,
  pinned?: OptionRow<T>,
): readonly OptionRun<T>[] {
  const runs: OptionRun<T>[] = []
  if (pinned !== undefined && pinned.slot < first) extend(runs, pinned)
  const end = Math.min(first + count, layout.slots.length)
  // Runs on every scroll frame of a long list, so a plain loop.
  for (let slot = first; slot < end; slot++) {
    const held = layout.slots[slot]!
    if ('nav' in held) extend(runs, held)
  }
  if (pinned !== undefined && pinned.slot >= first + count) extend(runs, pinned)
  return runs
}

/** Add `row` to the run it continues, or start a new run with it. */
function extend<T>(runs: OptionRun<T>[], row: OptionRow<T>): void {
  const last = runs[runs.length - 1]
  if (last !== undefined && last.group === row.group) last.rows.push(row)
  else runs.push({ group: row.group, rows: [row] })
}
