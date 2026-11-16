import type { Id, QueryResult } from 'latkit'

import { type Entity, entityLabel } from './document.js'
import type { Summary, TableState } from './messages.js'

interface CellRow {
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
const COLUMNS = 12
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
  const chosen = table?.columns?.[type]
  const kept = chosen?.filter((field) => fields.includes(field))
  // Columns chosen for fields the case no longer has leave the first ones on show, not none.
  return kept && (kept.length || !chosen?.length) ? kept : fields.slice(0, COLUMNS)
}
/** `table` with `change` applied. Switching type clears filters and sort, and a sort or value
 *  filter on a column no longer shown is dropped. */
export function changedTable(
  summary: Pick<Summary, 'counts' | 'definition' | 'identities'> | undefined,
  table: TableState,
  change: Partial<TableState>,
): TableState {
  const current = summary ? shownType(summary, table) : table.type
  const other = change.type !== undefined && change.type !== current
  const next: Record<string, unknown> = {
    ...table,
    ...(other && { filter: undefined, equal: undefined, order: undefined }),
    ...change,
  }
  const type = summary && shownType(summary, next)
  if (summary && type) {
    const columns = shownColumns(summary, next, type)
    for (const key of ['order', 'equal'] as const)
      if (next[key] && !columns.includes((next[key] as { field: string }).field)) delete next[key]
  }
  for (const key of Object.keys(next))
    if (next[key] === undefined || next[key] === '') delete next[key]
  return next as TableState
}
/** A cell's text. A whole number is written out, since a count or a number that names something
 *  must read exactly. Any other number shows six significant digits. */
export function cellText(value: unknown): string {
  return typeof value === 'number'
    ? String(Number.isInteger(value) ? value : Number(value.toPrecision(6)))
    : display(value, { native: true })
}

/** What the Case panel says in place of rows, or nothing: while it has rows, is reading them, or
 *  could not read them, which a notification says. `answered` is whether its last page arrived. */
export function emptyText(panel: {
  readonly open: boolean
  readonly read: boolean
  readonly unreadable: boolean
  readonly rows: number
  readonly loading: boolean
  readonly answered: boolean
  readonly filtered: boolean
}): string {
  if (!panel.open) return 'Open a GridKit case.'
  if (!panel.read) return panel.unreadable ? '' : 'Loading case…'
  if (panel.rows || panel.loading || !panel.answered) return ''
  return panel.filtered ? 'No elements match the filter.' : 'This case has no elements.'
}

/** `widths` grown to hold each of `measured`, so a column never narrows as other rows scroll into
 *  view. The same record when nothing grew. */
export function grown(
  widths: Readonly<Record<string, number>>,
  measured: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const wider = Object.entries(measured).filter(([key, width]) => width > (widths[key] ?? 0))
  return wider.length ? { ...widths, ...Object.fromEntries(wider) } : widths
}

export function display(value: unknown, { native: short = false } = {}): string {
  if (value && typeof value === 'object' && 'table' in value && 'id' in value)
    return short ? String(value.id) : entityLabel(value as Entity)
  return value === null || value === undefined
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
}
