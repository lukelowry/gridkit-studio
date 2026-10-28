import type { Id, QueryResult } from 'latkit'

import { type Entity, entityLabel } from './document.js'
import type { Summary, TableState } from './messages.js'

export interface CellRow {
  readonly id: Id
  readonly entity: Entity
  readonly values: Record<string, unknown>
}
export function cell(page: QueryResult, field: string, row: number): unknown {
  const values = page.fields[field]
  if (!values) return null
  if ('reference' in values) {
    const id = values.ids[row]
    return id === null || id === undefined ? null : { table: values.reference, id }
  }
  const value = values[row]
  return typeof value === 'number' && !Number.isFinite(value) ? null : (value ?? null)
}
export function rowsOf(page: QueryResult): CellRow[] {
  return page.ids.map((id, row) => ({
    id,
    entity: { table: page.table, id },
    values: Object.fromEntries(
      Object.keys(page.fields).map((name) => [name, cell(page, name, row)]),
    ),
  }))
}
export const COLUMNS = 12
export function tableFields(
  { definition, identities }: Pick<Summary, 'definition' | 'identities'>,
  table: string,
): string[] {
  return (
    definition.tables
      .find((item) => item.name === table)
      ?.fields.filter(
        (field) =>
          field.kind !== 'sampled' &&
          field.name !== identities[table] &&
          !field.name.startsWith('@studio.'),
      )
      .map((field) => field.name) ?? []
  )
}
export function shownType(
  { counts }: Pick<Summary, 'counts'>,
  table: TableState | undefined,
): string | undefined {
  const named = table?.type
  return named && counts[named] ? named : Object.keys(counts).find((type) => counts[type]! > 0)
}
export function shownColumns(
  summary: Pick<Summary, 'definition' | 'identities'>,
  table: TableState | undefined,
  type: string,
): string[] {
  const fields = tableFields(summary, type)
  return (
    table?.columns?.[type]?.filter((field) => fields.includes(field)) ?? fields.slice(0, COLUMNS)
  )
}
export function changedTable(
  summary: Pick<Summary, 'counts'> | undefined,
  table: TableState,
  change: Partial<TableState>,
): TableState {
  const shown = summary ? shownType(summary, table) : table.type
  const other = change.type !== undefined && change.type !== shown
  const next: Record<string, unknown> = {
    ...table,
    ...(other && { filter: undefined, equal: undefined, order: undefined }),
    ...change,
  }
  for (const key of Object.keys(next))
    if (next[key] === undefined || next[key] === '') delete next[key]
  return next as TableState
}
export const leaf = (field: string): string => field.slice(field.indexOf('.') + 1)
export function display(value: unknown, { native: short = false } = {}): string {
  if (value && typeof value === 'object' && 'table' in value && 'id' in value)
    return short ? String(value.id) : entityLabel(value as Entity)
  return value === null || value === undefined
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
}
