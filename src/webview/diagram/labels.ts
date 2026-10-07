import {
  type Data,
  type FieldInput,
  type FieldValues,
  itemId,
  rowAt,
  rowCount,
  type TableData,
  textAt,
  textColumn,
} from '@latkit/model'

import { nameFieldOf } from '../../shared/schema.js'

/** Per table: a table's labels are read once, and every config after reuses them. */
const cache = new WeakMap<TableData, FieldInput>()

/** The label field of `type`: its name field when every row has a name, else the names with ids
 *  for the rows that lack one. */
export function labelsOf(source: Data, type: string): FieldInput | null {
  const table = source.tables[type]
  if (!table) return null
  const cached = cache.get(table)
  if (cached) return cached
  const name = nameFieldOf(source.schema, type)
  const names = new Map<number, string>()
  if (name)
    for (const page of table.fields[name] ?? []) {
      if (page.column.kind !== 'text') continue
      for (let k = 0; k < rowCount(page.rows); k++) {
        const value = textAt(page.column, k)
        if (value?.trim()) names.set(rowAt(page.rows, k), value)
      }
    }
  if (name && names.size === rowCount(table.rows)) {
    cache.set(table, name)
    return name
  }
  const values = Array.from({ length: rowCount(table.rows) }, (_, k) => {
    const row = rowAt(table.rows, k)
    return names.get(row) ?? itemId({ source, index: table.index, row })
  })
  const field: FieldValues = { index: table.index, rows: table.rows, values: textColumn(values) }
  cache.set(table, field)
  return field
}
