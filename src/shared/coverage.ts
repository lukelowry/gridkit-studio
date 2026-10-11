/** Sets of a table's rows: whether some cover others, their union and their intersection. */
import {
  type Data,
  failure,
  type FieldSelection,
  type RowAxis,
  type RowSelection,
  selectRows,
} from '@latkit/model'

/** Half-open physical row intervals. Compact ranges keep whole-case checks constant-size. */
type Interval = readonly [number, number]
const rowIntervals = new WeakMap<RowAxis, readonly Interval[]>()
function intervals(rows: RowAxis): readonly Interval[] {
  let found = rowIntervals.get(rows)
  if (found) return found
  if (rows.kind === 'range') found = rows.count ? [[rows.offset, rows.offset + rows.count]] : []
  else {
    const result: [number, number][] = []
    for (const row of [...rows.values].sort((a, b) => a - b)) {
      const last = result.at(-1)
      if (last && row <= last[1]) last[1] = Math.max(last[1], row + 1)
      else result.push([row, row + 1])
    }
    found = result
  }
  rowIntervals.set(rows, found)
  return found
}

export function coversRows(available: readonly RowAxis[], required: RowAxis): boolean {
  const all = available.flatMap((rows) => [...intervals(rows)]).sort((a, b) => a[0] - b[0])
  let i = 0
  for (const [start, end] of intervals(required)) {
    let at = start
    while (i < all.length && all[i]![1] <= at) i++
    while (i < all.length && all[i]![0] <= at && at < end) at = Math.max(at, all[i++]![1])
    if (at < end) return false
    // An available interval may also contain the next required interval.
    if (i && all[i - 1]![1] > end) i--
  }
  return true
}

/** Resolve and union mixed IDs, ranges and indices against exactly one physical row space. */
function resolveRows(
  data: Data,
  from: string,
  selections: readonly (RowSelection | undefined)[],
): RowSelection {
  const table = data.tables[from]
  if (!table) throw failure('invalid-input', `Missing row space: ${from}`)
  const axes = selections.map((rows) => selectRows(table, rows))
  if (coversRows(axes, table.rows)) return { ...table.rows, index: table.index }
  const values = new Set<number>()
  for (const axis of axes)
    for (const [start, end] of intervals(axis))
      for (let row = start; row < end; row++) values.add(row)
  return {
    kind: 'indices',
    index: table.index,
    values: Uint32Array.from([...values].sort((a, b) => a - b)),
  }
}

export function recordedSelection(
  data: Data,
  outputs: readonly FieldSelection[],
  from: string,
  field: string,
): RowSelection {
  return resolveRows(
    data,
    from,
    outputs.filter((f) => f.from === from && f.select.includes(field)).map((f) => f.rows),
  )
}

export function intersectRows(a: RowAxis, b: RowAxis): RowAxis {
  const out: [number, number][] = []
  const left = intervals(a)
  const right = intervals(b)
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const [lo, hi] = left[i]!
    const [start, end] = right[j]!
    if (Math.max(lo, start) < Math.min(hi, end)) out.push([Math.max(lo, start), Math.min(hi, end)])
    if (hi < end) i++
    else j++
  }
  if (out.length === 1) return { kind: 'range', offset: out[0]![0], count: out[0]![1] - out[0]![0] }
  return {
    kind: 'indices',
    values: Uint32Array.from(
      out.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i)),
    ),
  }
}
