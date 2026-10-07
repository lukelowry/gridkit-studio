/** Coverage is measured from immutable pages, never inferred from a requested window. */
import {
  appendedPages,
  type ColumnPage,
  type ColumnPages,
  type Data,
  type Domain,
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

export interface SampleCoverage {
  readonly from: string
  readonly field: string
  readonly rows: RowSelection
  readonly first: number
  readonly count: number
  readonly domain: Domain
}

/** Frames `first` up to `end` whose samples hold every required row, and their times. */
interface Span {
  readonly first: number
  readonly end: number
  readonly domain: Domain
}

/** A short name for the rows a span covers, kept with them. */
const rowKeys = new WeakMap<RowAxis, string>()
function rowKey(rows: RowAxis): string {
  let key = rowKeys.get(rows)
  if (key === undefined) rowKeys.set(rows, (key = intervals(rows).join(';')))
  return key
}

/** The spans of each field's pages, by the rows they cover. */
const measured = new WeakMap<ColumnPages, Map<string, readonly Span[]>>()
/** The pages last measured after each first page. A field's pages grow by appending while its
 *  first page stands, so the next measure starts where the new pages could change the last. */
const latest = new WeakMap<
  ColumnPage,
  Map<string, { pages: ColumnPages; spans: readonly Span[] }>
>()

/** The spans of `pages` over `rows`, measured from page boundaries, never from each frame. */
function spans(pages: ColumnPages | undefined, rows: RowAxis): readonly Span[] {
  const head = pages?.at(0)
  if (!pages || !head) return []
  const key = rowKey(rows)
  let exact = measured.get(pages)
  if (!exact) measured.set(pages, (exact = new Map()))
  const cached = exact.get(key)
  if (cached) return cached
  let grown = latest.get(head)
  if (!grown) latest.set(head, (grown = new Map()))
  const before = grown.get(key)
  const added = before && appendedPages(before.pages, pages)
  let result: readonly Span[]
  if (added) {
    // Spans ending before the first new frame stand; the rest are measured again from there.
    let from = Infinity
    for (const page of added) from = Math.min(from, page.samples?.firstFrame ?? Infinity)
    const kept = before.spans.filter((span) => span.end <= from)
    const redone = before.spans.find((span) => span.end > from)
    result = joined(kept, sweep(pages, Math.min(from, redone?.first ?? from), rows))
  } else result = sweep(pages, 0, rows)
  exact.set(key, result)
  grown.set(key, { pages, spans: result })
  return result
}

/** Sweep the boundaries of the pages that reach frame `from` or past it. */
function sweep(pages: ColumnPages, from: number, rows: RowAxis): Span[] {
  const events = new Map<number, { add: number[]; remove: number[] }>()
  const samples: ColumnPage[] = []
  const event = (at: number) => {
    let value = events.get(at)
    if (!value) events.set(at, (value = { add: [], remove: [] }))
    return value
  }
  for (const page of pages) {
    const sample = page.samples
    const end = sample ? sample.firstFrame + sample.coordinates.length : 0
    if (!sample?.coordinates.length || end <= from) continue
    event(Math.max(from, sample.firstFrame)).add.push(samples.length)
    event(end).remove.push(samples.length)
    samples.push(page)
  }
  const active = new Set<number>()
  const boundaries = [...events.keys()].sort((a, b) => a - b)
  const result: Span[] = []
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const first = boundaries[i]!
    const end = boundaries[i + 1]!
    const changes = events.get(first)!
    for (const p of changes.remove) active.delete(p)
    for (const p of changes.add) active.add(p)
    const held = [...active].map((p) => samples[p]!)
    if (
      !held.length ||
      !coversRows(
        held.map((p) => p.rows),
        rows,
      )
    )
      continue
    const sample = held[0]!.samples!
    const domain: Domain = [
      sample.coordinates[first - sample.firstFrame]!,
      sample.coordinates[end - sample.firstFrame - 1]!,
    ]
    const last = result.at(-1)
    if (last?.end === first)
      result[result.length - 1] = { ...last, end, domain: [last.domain[0], domain[1]] }
    else result.push({ first, end, domain })
  }
  return result
}

/** `before` then `after`, joining the span where one ends as the next begins. */
function joined(before: readonly Span[], after: readonly Span[]): readonly Span[] {
  const last = before.at(-1)
  const next = after[0]
  if (!last || !next || last.end !== next.first) return [...before, ...after]
  return [
    ...before.slice(0, -1),
    { first: last.first, end: next.end, domain: [last.domain[0], next.domain[1]] },
    ...after.slice(1),
  ]
}

export function validateCoverage(data: Data, expected: readonly SampleCoverage[]): void {
  for (const item of expected) {
    const table = data.tables[item.from]
    const rows = table && selectRows(table, item.rows)
    const complete =
      rows &&
      spans(table!.fields[item.field], rows).some(
        (span) =>
          span.first <= item.first &&
          span.end >= item.first + item.count &&
          span.domain[0] <= item.domain[0] &&
          span.domain[1] >= item.domain[1],
      )
    if (!complete)
      throw Object.assign(
        failure('invalid-input', `Incomplete sample coverage: ${item.from}.${item.field}`),
        { coverage: item },
      )
  }
}

/** Whether the samples held cover every one of `selection`'s rows over all of `interval`. */
export function coversInterval(
  data: Data,
  from: string,
  field: string,
  [start, end]: Domain,
  selection?: RowSelection,
): boolean {
  const table = data.tables[from]
  if (!table) return false
  return spans(table.fields[field], selectRows(table, selection)).some(
    ({ domain }) => start >= domain[0] && end <= domain[1],
  )
}

/** True only inside actual complete sample coverage; never holds an evicted tail indefinitely. */
export function coversTime(
  data: Data,
  from: string,
  field: string,
  at: number,
  selection?: RowSelection,
): boolean {
  return coversInterval(data, from, field, [at, at], selection)
}

export function validateStatics(
  data: Data,
  fields: readonly FieldSelection[],
  counts: Readonly<Record<string, number>>,
): void {
  for (const { from, select, rows } of fields) {
    if ((counts[from] ?? 0) === 0) continue
    const table = data.tables[from]
    if (!table) throw failure('invalid-input', `Missing row space: ${from}`)
    const required = rows
      ? selectRows(table, rows)
      : { kind: 'range' as const, offset: 0, count: counts[from]! }
    if (!coversRows([table.rows], required))
      throw failure('invalid-input', `Incomplete row space: ${from}`)
    for (const field of select) {
      if (data.schema.types[from]?.fields[field]?.sampled) continue
      if (
        !coversRows(
          [...(table.fields[field] ?? [])].map((page) => page.rows),
          required,
        )
      )
        throw failure('invalid-input', `Incomplete static coverage: ${from}.${field}`)
    }
  }
}

/** The first of `count` places at which `before` stops holding, as it holds only for a prefix. */
function boundary(count: number, before: (i: number) => boolean): number {
  let low = 0
  let high = count
  while (low < high) {
    const middle = (low + high) >>> 1
    if (before(middle)) low = middle + 1
    else high = middle
  }
  return low
}

/** The pages from `from` up to `end` that overlap `window`, with a neighboring page on each side
 *  for floor sampling and for segments crossing the window's ends. Pages are in time order. */
export function pageWindow(
  pages: readonly { domain: Domain }[],
  window?: Domain,
  from = 0,
  end = pages.length,
): readonly [number, number] {
  if (!window) return [from, end]
  const first = boundary(end, (p) => pages[p]!.domain[1] < window[0])
  const last = boundary(end, (p) => pages[p]!.domain[0] <= window[1])
  return [Math.max(from, first - 1, 0), Math.min(end, last + 1)]
}
