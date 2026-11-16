import { Data, type Expr, field, type Fields, type Id, Patch, type Query } from 'latkit'

import {
  type CaseRowsCursor,
  type CaseRowsPage,
  type FieldSelection,
  PAGE_BYTES,
  type TablePage,
  type TableRequest,
} from '../shared/data.js'
import { LABEL } from '../shared/document.js'
import type { CaseColumns } from './document.js'
import { Turns } from './turns.js'

/** Rows the Case panel's query columns load per step, between turns. */
const ROWS_PER_STEP = 4096

/** The fraction of a page rows are sized to fill, leaving room for slightly larger rows. */
const FILL = 0.9

/** Writes up to `count` rows as one page, retrying with the count the measured size suggests
 *  when it exceeds PAGE_BYTES. At least one row always goes. */
async function paged(
  rows: number,
  count: number,
  write: (count: number) => Uint8Array,
  turns: Turns,
): Promise<{ bytes: Uint8Array; count: number }> {
  for (count = Math.min(rows, count); ;) {
    const bytes = write(count)
    turns.signal.throwIfAborted()
    if (bytes.byteLength <= PAGE_BYTES || count <= 1) return { bytes, count }
    const fits = Math.floor((FILL * count * PAGE_BYTES) / bytes.byteLength)
    count = Math.max(1, Math.min(count - 1, fits))
    await turns.step()
  }
}

const caseRowsKey = (document: CaseColumns, selection: readonly FieldSelection[]): string =>
  document.key + ':' + JSON.stringify(selection)

/** Validates the selection and adds reference target tables before any references are written. */
function included(document: CaseColumns, selection: readonly FieldSelection[]) {
  const tables = new Map<string, readonly string[]>()
  for (const { table, fields } of selection) {
    const definition = document.definition.tables.find((item) => item.name === table)
    if (!definition || !document.tables.has(table)) throw new Error(`Unknown table: ${table}`)
    if (tables.has(table)) throw new Error(`Repeated table: ${table}`)
    for (const name of fields) {
      const definitionField = definition.fields.find((item) => item.name === name)
      if (!definitionField) throw new Error(`Unknown field: ${table}.${name}`)
      if (definitionField.kind === 'sampled') throw new Error('Sampled fields belong to results.')
    }
    tables.set(table, [...new Set(fields)])
  }
  for (const { table, fields } of selection) {
    const definition = document.definition.tables.find((item) => item.name === table)!
    for (const name of fields) {
      const target = definition.fields.find((item) => item.name === name)?.target
      if (target && !tables.has(target)) {
        if (!document.tables.has(target)) throw new Error(`Missing reference table: ${target}`)
        tables.set(target, [])
      }
    }
  }
  return [...tables]
}

/** Stateless, bounded pages. A cursor carries the previous page's row count to size the next. */
export async function caseRowsPage(
  document: CaseColumns,
  selection: readonly FieldSelection[],
  cursor: CaseRowsCursor | undefined,
  signal: AbortSignal,
): Promise<CaseRowsPage> {
  const tables = included(document, selection)
  let { phase, table: index, offset } = cursor ?? { phase: 'identities', table: 0, offset: 0 }
  const previousCount = cursor?.count
  if (
    (phase !== 'identities' && phase !== 'fields') ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > tables.length ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (previousCount !== undefined && !(Number.isSafeInteger(previousCount) && previousCount >= 1))
  )
    throw new Error('Invalid rows cursor.')
  const turns = new Turns(signal)
  for (;;) {
    await turns.step()
    if (index === tables.length) {
      if (phase === 'fields')
        return { key: caseRowsKey(document, selection), bytes: new Patch('case').toBytes() }
      phase = 'fields'
      index = 0
      offset = 0
      continue
    }
    const [name, fields] = tables[index]!
    const table = document.tables.get(name)!
    if (offset > table.ids.length) throw new Error('Rows cursor exceeds its table.')
    if (phase === 'fields' && fields.length === 0) {
      index++
      offset = 0
      continue
    }
    if (table.ids.length === offset && offset !== 0)
      throw new Error('Rows cursor is past its last row.')
    const rows = table.ids.length - offset
    const { bytes, count } = await paged(
      rows,
      offset > 0 && previousCount !== undefined ? previousCount : rows,
      (count) => {
        const values: Record<string, Fields[string]> = {}
        if (phase === 'fields') {
          for (const name of fields) values[name] = table.read(name, offset, count)
        }
        const patch = new Patch('case')
        return count === 0
          ? patch.replace(name, [], values).toBytes()
          : patch.set(name, table.ids.slice(offset, offset + count), values).toBytes()
      },
      turns,
    )
    offset += count
    if (offset === table.ids.length) {
      index++
      offset = 0
    }
    // Advance over fieldless tables so completion requires no empty follow-up request.
    if (index === tables.length && phase === 'identities') {
      phase = 'fields'
      index = 0
    }
    if (phase === 'fields') {
      while (index < tables.length && tables[index]![1].length === 0) index++
    }
    return {
      key: caseRowsKey(document, selection),
      bytes,
      ...(index < tables.length
        ? { next: { phase, table: index, offset, ...(offset > 0 && { count }) } }
        : {}),
    }
  }
}

/** Orders texts as a reader expects: letters without regard to case, and digits by their value, so
 *  `Bus 9` comes before `Bus 10`. */
const TEXTS = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** A revision's query dataset, released with its cache entry. */
export class CaseQueries {
  readonly data = new Data('case-query')
  /** Per table, the fields already loaded into `data`. */
  readonly #loaded = new Map<string, Set<string>>()
  /** Each table's ids ordered by a text field, by table, field and direction. */
  readonly #orders = new Map<string, Id[]>()
  #destroyed = false

  constructor(private readonly document: CaseColumns) {
    try {
      for (const [name, table] of document.tables) {
        this.data.replace(name, table.ids)
        this.#loaded.set(name, new Set())
      }
    } catch (error) {
      this.data.destroy()
      throw error
    }
  }

  async #ensure(tableName: string, fields: readonly string[], signal: AbortSignal): Promise<void> {
    const table = this.document.tables.get(tableName)
    const loaded = this.#loaded.get(tableName)
    const definition = this.document.definition.tables.find((item) => item.name === tableName)
    if (!table || !loaded || !definition) throw new Error(`Unknown table: ${tableName}`)
    const missing = [...new Set(fields)].filter((name) => !loaded.has(name))
    for (const name of missing) {
      const field = definition.fields.find((item) => item.name === name)
      if (!field || field.kind === 'sampled')
        throw new Error(`Not a static field: ${tableName}.${name}`)
    }
    if (!missing.length) return
    const turns = new Turns(signal)
    if (!table.ids.length) {
      signal.throwIfAborted()
      if (this.#destroyed) throw new Error('The query revision was released.')
      this.data.set(
        tableName,
        [],
        Object.fromEntries(missing.map((name) => [name, table.read(name, 0, 0)])),
      )
    }
    for (let offset = 0; offset < table.ids.length; offset += ROWS_PER_STEP) {
      await turns.step()
      if (this.#destroyed) throw new Error('The query revision was released.')
      const count = Math.min(ROWS_PER_STEP, table.ids.length - offset)
      const values: Record<string, Fields[string]> = {}
      for (const name of missing) values[name] = table.read(name, offset, count)
      this.data.set(tableName, table.ids.slice(offset, offset + count), values)
    }
    signal.throwIfAborted()
    for (const name of missing) loaded.add(name)
  }

  /** The ids of `tableName` ordered by text field `field`. latkit's queries sort by numbers alone,
   *  so text is ordered here and given to them as the rows to read. As in a query's own sort, rows
   *  without a text come last in either direction and equal rows keep their order. */
  #ordered(tableName: string, { field, direction }: NonNullable<TableRequest['order']>): Id[] {
    const key = JSON.stringify([tableName, field, direction])
    let ids = this.#orders.get(key)
    if (!ids) {
      const table = this.document.tables.get(tableName)!
      const texts = table.read(field, 0, table.ids.length) as ArrayLike<unknown>
      const text = (place: number) => {
        const value = texts[place]
        return typeof value === 'string' && value !== '' ? value : undefined
      }
      const sign = direction === 'ascending' ? 1 : -1
      const places = Uint32Array.from(table.ids, (_, place) => place).sort((a, b) => {
        const [first, second] = [text(a), text(b)]
        if (first === undefined || second === undefined)
          return first === second ? a - b : first === undefined ? 1 : -1
        return sign * TEXTS.compare(first, second) || a - b
      })
      this.#orders.set(key, (ids = Array.from(places, (place) => table.ids[place]!)))
    }
    return ids
  }

  async page(request: TableRequest, signal: AbortSignal): Promise<TablePage> {
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1
    ) {
      throw new Error('Invalid table page.')
    }
    const definition = this.document.definition.tables.find((item) => item.name === request.table)
    if (!definition) throw new Error(`Unknown table: ${request.table}`)
    await this.#ensure(
      request.table,
      [
        ...request.fields,
        ...(request.search ? [definition.labelField, LABEL] : []),
        ...(request.equal ? [request.equal.field] : []),
        ...(request.order ? [request.order.field] : []),
      ],
      signal,
    )
    signal.throwIfAborted()
    if (this.#destroyed) throw new Error('The query revision was released.')
    let filter: Expr | undefined
    if (request.search) {
      filter = field(definition.labelField)
        .contains(request.search)
        .or(field(LABEL).contains(request.search))
    }
    if (request.equal) {
      const { field: name, value } = request.equal
      const equal =
        typeof value === 'string'
          ? field(name).is(value)
          : field(name).eq(typeof value === 'boolean' ? Number(value) : value)
      filter = filter ? filter.and(equal) : equal
    }
    const { order } = request
    const byText =
      order && definition.fields.find((item) => item.name === order.field)?.kind === 'text'
        ? this.#ordered(request.table, order)
        : undefined
    const asked = request.ids && new Set(request.ids)
    const kept: Query = {
      of: request.table,
      ...(byText
        ? { ids: asked ? byText.filter((id) => asked.has(id)) : byText }
        : request.ids
          ? { ids: [...request.ids] }
          : {}),
      ...(filter ? { filter } : {}),
      ...(order && !byText ? { sort: [[field(order.field), order.direction]] } : {}),
    }
    // An anchored page shows its anchor a few rows down. When the anchor is filtered out, the
    // requested offset is used and `anchored` is false.
    const at =
      request.anchor === undefined
        ? undefined
        : this.data.query({ ...kept, select: {} }).ids.indexOf(request.anchor)
    const offset = at !== undefined && at >= 0 ? Math.max(0, at - 10) : request.offset
    const result = this.data.query({
      ...kept,
      offset,
      limit: request.limit,
      select: Object.fromEntries(request.fields.map((name) => [name, field(name)])),
    })
    signal.throwIfAborted()
    return { ...result, offset, ...(at !== undefined && { anchored: at >= 0 }) }
  }

  destroy(): void {
    this.#destroyed = true
    this.#loaded.clear()
    this.#orders.clear()
    this.data.destroy()
  }
}
