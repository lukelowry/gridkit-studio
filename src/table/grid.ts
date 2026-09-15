import { type ClassData, createGrid, type Grid, type GridSort } from '@latkit/model'

import type { CaseFields } from '../fields.js'

const cell = (value: number) => (Number.isNaN(value) ? '' : String(value))

// The query engine sorts original f64 columns; only visible numeric cells are formatted here.
export function caseGrid(data: ClassData): Grid {
  const grid = createGrid(data.labels, data.columns)
  return {
    ...grid,
    async window(query, sort, offset, limit, signal) {
      const window = await grid.window(query, sort, offset, limit, signal)
      signal?.throwIfAborted()
      return {
        ...window,
        rows: window.rows.map((row) => ({
          ...row,
          cells: row.cells.map((text, at) => {
            const column = data.columns[at]
            return column.kind === 'number' ? cell(column.values[row.index]) : text
          }),
        })),
      }
    },
  }
}

/** Static and recorded cells share query semantics. Recorded scans retain only matching
 * row indices; sorting materializes the one requested field at the current frame. */
export function recordedGrid(data: ClassData, fields: CaseFields, classId: string): Grid {
  const base = caseGrid(data)
  const recorded = fields.recorded(classId)
  const csv = fields.source!
  let sorted: Grid | undefined
  let sortKey = ''
  let filtered: { key: string; indices: number[] } | undefined
  const controller = new AbortController()
  const source = async (
    sort: GridSort | null,
    frame: number,
    time: number,
    signal?: AbortSignal,
  ) => {
    const field = recorded.find((field) => `@signal:${field.id}` === sort?.column)
    if (!field) return base
    const key = `${frame}:${field.id}`
    if (key !== sortKey) {
      const column = await fields.column(field, signal, time, frame)
      signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      sorted?.dispose()
      sorted = caseGrid({
        ...data,
        columns: [...data.columns, { ...column, id: `@signal:${field.id}` }],
      })
      sortKey = key
    }
    return sorted!
  }
  const hits = async (
    query: string,
    sort: GridSort | null,
    frame: number,
    grid: Grid,
    signal?: AbortSignal,
  ) => {
    const needle = query.trim().toLowerCase()
    const key = `${frame}:${needle}:${JSON.stringify(sort)}`
    if (filtered?.key === key) return filtered.indices
    const indices: number[] = []
    for (let offset = 0; offset < data.labels.length; offset += 1024) {
      const window = await grid.window('', sort, offset, 1024, signal)
      const values = await csv.cellsAt(
        frame,
        recorded,
        window.rows.map((row) => row.index),
        signal,
      )
      signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      window.rows.forEach((row, i) => {
        const cells = recorded.map((_, j) => cell(values[i * recorded.length + j]))
        if (
          [row.label, ...row.cells.slice(0, data.columns.length), ...cells]
            .join(' ')
            .toLowerCase()
            .includes(needle)
        )
          indices.push(row.index)
      })
    }
    filtered = { key, indices }
    return indices
  }
  const row = (index: number) => ({
    index,
    label: data.labels[index],
    cells: data.columns.map((column) =>
      column.kind === 'flag'
        ? column.values[index]
          ? 'true'
          : 'false'
        : column.kind === 'number'
          ? cell(column.values[index])
          : (column.values[index] ?? ''),
    ),
  })
  return {
    async window(query, sort, offset, limit, signal) {
      const time = fields.time
      const frame = fields.frame ?? (await csv.locate(time, signal))
      const grid = await source(sort, frame, time, signal)
      const indices = query.trim() ? await hits(query, sort, frame, grid, signal) : undefined
      const window = indices
        ? { rows: indices.slice(offset, offset + limit).map(row), total: indices.length }
        : await grid.window('', sort, offset, limit, signal)
      const values = await csv.cellsAt(
        frame,
        recorded,
        window.rows.map((row) => row.index),
        signal,
      )
      signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      return {
        ...window,
        rows: window.rows.map((row, i) => ({
          ...row,
          cells: [
            ...row.cells.slice(0, data.columns.length),
            ...recorded.map((_, j) => cell(values[i * recorded.length + j])),
          ],
        })),
      }
    },
    async locate(index, query, sort, signal) {
      const time = fields.time
      const frame = fields.frame ?? (await csv.locate(time, signal))
      const grid = await source(sort, frame, time, signal)
      if (!query.trim()) return grid.locate(index, '', sort, signal)
      const at = (await hits(query, sort, frame, grid, signal)).indexOf(index)
      return at < 0 ? null : at
    },
    dispose() {
      controller.abort()
      base.dispose()
      sorted?.dispose()
      filtered = undefined
    },
  }
}
