/** Index select options, filter them into grouped slots, and calculate visible rows and ARIA positions. */

/** An option a Select offers; it may sit under a heading and carry a color swatch. */
export interface SelectOption<T> {
  readonly value: T
  readonly label: string
  /** Options sharing a group sit under its heading; groups keep the order they first appear in. */
  readonly group?: string
  /** A CSS background painted as a small chip beside the label (a colormap gradient, say). */
  readonly swatch?: string
  /** Shown, but neither reachable from the keyboard nor choosable. */
  readonly disabled?: boolean
}

/** An option, or the clear row (`option` and `key` null), with its label lowercased once for
 *  matching. */
interface Entry<T> {
  readonly option: SelectOption<T> | null
  readonly key: string | null
  readonly label: string
  readonly text: string
}

/** The options by key, and grouped by heading in first-appearance order ('' for no heading). */
interface OptionIndex<T> {
  readonly byKey: ReadonlyMap<string, SelectOption<T>>
  readonly groups: readonly (readonly [heading: string, entries: readonly Entry<T>[]])[]
}

/** Rows under one heading (or none: `label` ''), occupying slots `[start, end)`, the heading's own
 *  slot included. */
export interface OptionGroup {
  readonly label: string
  readonly start: number
  readonly end: number
  /** The size of its ARIA set: its rows, or for rows under no heading, all such rows together. */
  readonly setsize: number
}

/** One row of the listbox: an option, or the clear row (`value` and `key` null). */
export interface OptionRow<T> extends Entry<T> {
  readonly value: T | null
  readonly group: OptionGroup
  /** Its layout position: every row and every named heading takes one slot. */
  readonly slot: number
  /** Its keyboard position, or -1 when disabled. */
  readonly nav: number
  /** Its 1-based position in its ARIA set. */
  readonly posinset: number
}

/** What a query leaves, in layout order and in keyboard order. */
interface OptionLayout<T> {
  /** Each slot holds a named heading's group or a row; the count sets the scroll height. */
  readonly slots: readonly (OptionGroup | OptionRow<T>)[]
  /** The enabled rows, in order. */
  readonly nav: readonly OptionRow<T>[]
  /** A key's keyboard position (null for the clear row). */
  readonly navOf: ReadonlyMap<string | null, number>
}

/** A stretch of consecutive rows in one group, as a window mounts them. */
interface OptionRun<T> {
  readonly group: OptionGroup
  readonly rows: readonly OptionRow<T>[]
}

/** Index `options` once under `key` (their text by default), so each query filters cached
 *  lowercase labels. */
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
    // Only labels are searched: a value is opaque data (a reference, say), not text.
    group.push({ option, key: text, label: option.label, text: option.label.toLowerCase() })
  }
  return { byKey, groups: [...grouped.entries()] }
}

/**
 * Lay out the options whose label contains every word of `query` (any case), group by group.
 * When `clear` names a clear row it leads the list, but only while there is no query: a search
 * shows matches alone. Groups left empty by the query vanish.
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
  // Rows under no heading sit directly in the listbox, so together they form one ARIA set, whose
  // size is known only once every group is laid out.
  const headless: { setsize: number }[] = []
  let loose = 0

  // A search runs this over every option on each keystroke, so it is a plain loop.
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
      const entry = entries[position]!
      const enabled = entry.option === null || entry.option.disabled !== true
      const row: OptionRow<T> = {
        ...entry,
        value: entry.option === null ? null : entry.option.value,
        group,
        slot: slots.length,
        nav: enabled ? nav.length : -1,
        posinset: named ? position + 1 : ++loose,
      }
      slots.push(row)
      if (!enabled) continue
      navOf.set(row.key, row.nav)
      nav.push(row)
    }
  }

  if (clear !== null && words.length === 0) {
    place('', [{ option: null, key: null, label: clear, text: clear.toLowerCase() }])
  }
  for (const [heading, entries] of index.groups)
    place(heading, words.length === 0 ? entries : entries.filter(matches))
  for (const group of headless) group.setsize = loose
  return { slots, nav, navOf }
}

/**
 * The rows in slots `[first, first + count)`, split into runs by group, with `pinned` (the active
 * row) added at whichever end it lies beyond, so it stays mounted while scrolled out of view.
 */
export function windowRuns<T>(
  layout: OptionLayout<T>,
  first: number,
  count: number,
  pinned?: OptionRow<T>,
): readonly OptionRun<T>[] {
  const runs: Run<T>[] = []
  if (pinned !== undefined && pinned.slot < first) extend(runs, pinned)
  const end = Math.min(first + count, layout.slots.length)
  // Runs on every scroll frame of a long list: a plain loop, no intermediate arrays.
  for (let slot = first; slot < end; slot++) {
    const held = layout.slots[slot]!
    if ('nav' in held) extend(runs, held)
  }
  if (pinned !== undefined && pinned.slot >= first + count) extend(runs, pinned)
  return runs
}

type Run<T> = { group: OptionGroup; rows: OptionRow<T>[] }

/** Add `row` to the run it continues, or start the next run with it. */
function extend<T>(runs: Run<T>[], row: OptionRow<T>): void {
  const last = runs[runs.length - 1]
  if (last !== undefined && last.group === row.group) last.rows.push(row)
  else runs.push({ group: row.group, rows: [row] })
}
