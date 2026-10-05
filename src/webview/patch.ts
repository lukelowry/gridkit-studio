/** Least config patches: unchanged values stay out, so views keep their memoized work. */

type Plain = Record<string, unknown>

/** How a view's `set` merges each key: `records` per entry then per option, `merged` per option,
 *  and every other key whole. */
interface Shape {
  readonly records: readonly string[]
  readonly merged: readonly string[]
}

export const NETWORK: Shape = {
  records: ['vertices', 'edges', 'paths'],
  merged: ['camera', 'input', 'limits'],
}
export const DIAGRAM: Shape = {
  records: ['vertices', 'edges', 'groups'],
  merged: ['camera', 'input', 'limits', 'layout'],
}
export const MONITOR: Shape = { records: ['traces'], merged: ['camera', 'input', 'limits'] }

function isPlain(value: unknown): value is Plain {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

const keysOf = (a: Plain, b: Plain) => new Set([...Object.keys(a), ...Object.keys(b)])

/** Whether `a` and `b` are the same options. Absent equals null; Data, typed arrays, and other
 *  instances compare by identity. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b || (a == null && b == null)) return true
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((value, i) => same(value, b[i]))
  // Data is a plain object: its `tables` tell it apart.
  if (!isPlain(a) || !isPlain(b) || 'tables' in a) return false
  for (const key of keysOf(a, b)) if (!same(a[key], b[key])) return false
  return true
}

/** The options of `after` that differ from `before`, with null for each it drops. */
function options(before: Plain, after: Plain): Plain {
  const patch: Plain = {}
  for (const key of keysOf(before, after))
    if (!same(before[key], after[key])) patch[key] = after[key] ?? null
  return patch
}

/** The patch from `previous` to `next` for a view of `shape`; null when nothing changed. */
export function patchOf(previous: Plain, next: Plain, shape: Shape): Plain | null {
  const patch: Plain = {}
  for (const key of keysOf(previous, next)) {
    const before = previous[key]
    const after = next[key]
    if (same(before, after)) continue
    if (after == null || !isPlain(before) || !isPlain(after)) patch[key] = after ?? null
    else if (shape.merged.includes(key)) patch[key] = options(before, after)
    else if (!shape.records.includes(key)) patch[key] = after
    else {
      const entries: Plain = {}
      for (const entry of keysOf(before, after)) {
        const was = before[entry]
        const is = after[entry]
        if (same(was, is)) continue
        entries[entry] = is == null ? null : isPlain(was) && isPlain(is) ? options(was, is) : is
      }
      patch[key] = entries
    }
  }
  return Object.keys(patch).length ? patch : null
}
