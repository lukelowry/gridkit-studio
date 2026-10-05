import { setImmediate as yieldTurn } from 'node:timers/promises'

import { read, sampleAt, selectRows } from '@latkit/model'

import type { Analysis, AnalysisOptions, Comparison, ElementStats } from '../shared/analysis.js'
import type { Results } from './results.js'

export function snapshot(run: Results) {
  return { info: structuredClone(run.info), pages: run.pages.length }
}

/** How many ranked rows a result returns: `value`, else the 20 worst. */
export function analysisLimit(value = 20) {
  if (!Number.isInteger(value) || value < 1) throw new Error('Limit must be a positive integer.')
  return value
}

export function analysisSelection(
  run: Results,
  options: AnalysisOptions,
  captured = snapshot(run),
) {
  const { from, field, ids, order = 'min' } = options
  analysisLimit(options.limit)
  if (order !== 'min' && order !== 'max') throw new Error('Order must be min or max.')
  const definition = run.kase.schema.types[from]?.fields[field]
  if (!definition?.sampled) throw new Error('Choose a sampled numeric field from the run outputs.')
  const recorded = run.fields.find((f) => f.index.type === from && f.name === field)
  if (!recorded) throw new Error(`${from}.${field} was not recorded by this run.`)
  const table = run.kase.table(from)
  const axis = ids ? selectRows(run.kase.data.tables[from]!, { kind: 'ids', ids }) : recorded.axis
  const selected = !ids
    ? recorded.rows
    : axis.kind === 'indices'
      ? axis.values
      : Uint32Array.from({ length: axis.count }, (_, n) => axis.offset + n)
  // Recorded rows are sorted. Validate a small ID selection without copying a wide run's coverage.
  if (ids) {
    if (new Set(ids).size !== ids.length) throw new Error('Choose distinct element IDs.')
    for (const row of selected) {
      let low = 0
      let high = recorded.rows.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (recorded.rows[mid]! < row) low = mid + 1
        else high = mid
      }
      if (recorded.rows[low] !== row)
        throw new Error(`${run.kase.id(table, row)} was not recorded for ${field}.`)
    }
  }
  const window = options.window ?? captured.info.domain
  if (window.length !== 2 || !window.every(Number.isFinite) || window[0] > window[1])
    throw new Error('Use a finite, ascending time window.')
  return { from, field, order, definition, table, selected, recorded, window }
}

/** Scans immutable published pages, retaining only per-element extrema and coverage. */
export async function analyze(
  run: Results,
  options: AnalysisOptions,
  signal: AbortSignal,
  captured = snapshot(run),
): Promise<Analysis> {
  signal.throwIfAborted()
  const { from, field, order, definition, table, selected, recorded, window } = analysisSelection(
    run,
    options,
    captured,
  )
  const stats = new Map<number, ElementStats>()
  const rowsSelection = { kind: 'indices' as const, index: recorded.index, values: selected }
  for (const row of selected)
    stats.set(row, { id: run.kase.id(table, row), valid: 0, missing: 0, min: null, max: null })
  for (let p = 0; p < captured.pages; p++) {
    const page = run.pages[p]!
    if (page.domain[1] < window[0] || page.domain[0] > window[1]) continue
    // A long scan lets the worker answer other requests between pages.
    await yieldTurn(undefined, { signal })
    const data = await run.pageData(p, signal)
    for await (const block of read(
      data,
      {
        kind: 'samples',
        from,
        select: [field],
        rows: rowsSelection,
        window: { kind: 'range', between: window },
      },
      { signal, maxBlockBytes: 256 << 10 },
    )) {
      if (block.kind !== 'samples') continue
      const count = block.rows.kind === 'range' ? block.rows.count : block.rows.values.length
      const column = block.columns[field]!
      for (let row = 0; row < count; row++) {
        const physical =
          block.rows.kind === 'range' ? block.rows.offset + row : block.rows.values[row]!
        const item = stats.get(physical)!
        for (let frame = 0; frame < block.coordinates.length; frame++) {
          const value = sampleAt(column, row, frame)
          if (value === null || !Number.isFinite(value)) {
            item.missing++
            continue
          }
          item.valid++
          if (!item.min || value < item.min.value)
            item.min = { value, time: block.coordinates[frame]!, frame: block.firstFrame + frame }
          if (!item.max || value > item.max.value)
            item.max = { value, time: block.coordinates[frame]!, frame: block.firstFrame + frame }
        }
      }
    }
  }
  const rows = [...stats.values()]
  rows.sort((a, b) => compareStats(a, b, order))
  const info = captured.info
  return {
    run: info.contingency?.study ?? info.id,
    study: info.contingency?.study,
    contingency: info.contingency?.shown,
    revision: info.revision,
    fingerprint: info.fingerprint,
    state: info.state,
    snapshot: { pages: captured.pages, frames: info.frames, domain: info.domain },
    from,
    field,
    unit: definition.unit ?? null,
    window,
    total: rows.length,
    rows,
  }
}

export function compareStats(a: ElementStats, b: ElementStats, order: 'min' | 'max') {
  const av = a[order]?.value
  const bv = b[order]?.value
  return (
    (av === undefined
      ? bv === undefined
        ? 0
        : 1
      : bv === undefined
        ? -1
        : order === 'min'
          ? av - bv
          : bv - av) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** Compare extrema on a shared interval; no resampling or inferred pointwise differences. */
export function compare(before: Analysis, after: Analysis, limit: number): Comparison {
  if (before.from !== after.from || before.field !== after.field || before.unit !== after.unit)
    throw new Error('Comparison requires the same field and units.')
  const earlier = new Map(before.rows.map((row) => [row.id, row]))
  const rows: Comparison['rows'] = []
  for (const row of after.rows) {
    const previous = earlier.get(row.id)
    if (previous)
      rows.push({
        id: row.id,
        before: previous,
        after: row,
        minDelta: previous.min && row.min ? row.min.value - previous.min.value : null,
        maxDelta: previous.max && row.max ? row.max.value - previous.max.value : null,
      })
  }
  rows.sort(
    (a, b) =>
      Math.max(Math.abs(b.minDelta ?? 0), Math.abs(b.maxDelta ?? 0)) -
        Math.max(Math.abs(a.minDelta ?? 0), Math.abs(a.maxDelta ?? 0)) || (a.id < b.id ? -1 : 1),
  )
  const { rows: _before, ...left } = before
  const { rows: _after, ...right } = after
  return {
    before: left,
    after: right,
    matched: rows.length,
    onlyBefore: before.total - rows.length,
    onlyAfter: after.total - rows.length,
    rows: rows.slice(0, analysisLimit(limit)),
  }
}
