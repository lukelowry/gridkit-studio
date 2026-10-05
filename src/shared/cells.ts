/** Decoding and displaying the cells of query results. */

import {
  bitAt,
  type Column,
  type Index,
  numberAt,
  type RowsBlock,
  type RowsQuery,
  textAt,
} from '@latkit/model'

/** The most rows one rows query may return. */
const PAGE = 100

interface Row {
  id: string | null
  row: number
  values: Record<string, unknown>
}

const referenceKey = (index: Index, row: number): string => JSON.stringify([index, row])

/** The value at `row`, null when missing; a reference carries its target's id when `references`
 *  names it. */
function cell(column: Column, row: number, references?: ReadonlyMap<string, string>): unknown {
  if (column.validity && !bitAt(column.validity, column.offset + row)) return null
  switch (column.kind) {
    case 'numeric':
      return numberAt(column, row)
    case 'boolean':
      return bitAt(column.values, column.offset + row)
    case 'text':
      return textAt(column, row)
    case 'reference': {
      const n = column.values[column.offset + row]!
      return { index: column.index, row: n, id: references?.get(referenceKey(column.index, n)) }
    }
    case 'vector':
      return Array.from({ length: column.size }, (_, n) =>
        cell(column.values, (column.offset + row) * column.size + n),
      )
    case 'list': {
      const start = column.offsets[column.offset + row]!
      const end = column.offsets[column.offset + row + 1]!
      return Array.from({ length: end - start }, (_, n) => cell(column.values, start + n))
    }
  }
}

export function rowsOf(
  blocks: readonly RowsBlock[],
  references?: ReadonlyMap<string, string>,
): Row[] {
  return blocks.flatMap((block) => {
    const length = block.rows.kind === 'range' ? block.rows.count : block.rows.values.length
    return Array.from({ length }, (_, row) => ({
      id: block.ids ? textAt(block.ids, row) : '',
      row: block.rows.kind === 'range' ? block.rows.offset + row : block.rows.values[row]!,
      values: Object.fromEntries(
        Object.entries(block.columns).map(([name, column]) => [
          name,
          cell(column, row, references),
        ]),
      ),
    }))
  })
}

/** A cell as text: a reference by its target's id, a missing value as a dash. */
export function display(value: unknown): string {
  if (value && typeof value === 'object' && 'index' in value && 'row' in value)
    return 'id' in value && typeof value.id === 'string'
      ? value.id
      : (value.index as { type: string }).type + ' (connected)'
  return value === null || value === undefined
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
}

/** The ids of the rows the reference columns of `blocks` point at, for `rowsOf`; physical row
 *  numbers are never shown. */
export async function referenceNames(
  blocks: readonly RowsBlock[],
  query: (query: RowsQuery) => Promise<RowsBlock[]>,
): Promise<Map<string, string>> {
  const groups = new Map<string, { index: Index; rows: Set<number> }>()
  for (const block of blocks)
    for (const column of Object.values(block.columns)) {
      if (column.kind !== 'reference') continue
      const key = JSON.stringify(column.index)
      let group = groups.get(key)
      if (!group) {
        group = { index: column.index, rows: new Set() }
        groups.set(key, group)
      }
      for (let row = 0; row < column.length; row++) {
        const value = numberAt(column, row)
        if (value !== null) group.rows.add(value)
      }
    }
  const names = new Map<string, string>()
  for (const { index, rows } of groups.values()) {
    const values = Uint32Array.from(rows)
    for (let start = 0; start < values.length; start += PAGE) {
      const found = await query({
        kind: 'rows',
        from: index.type,
        select: [],
        ids: true,
        limit: PAGE,
        rows: { kind: 'indices', index, values: values.slice(start, start + PAGE) },
      })
      for (const row of rowsOf(found)) if (row.id) names.set(referenceKey(index, row.row), row.id)
    }
  }
  return names
}
