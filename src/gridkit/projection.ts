import { createHash } from 'node:crypto'

import { Data, type Expr, field, type Fields, Patch, type Query } from 'latkit'

import {
  ENTRY_BYTES,
  PAGE_BYTES,
  type ProjectionCursor,
  type ProjectionPage,
  type ProjectionSelection,
  type TablePage,
  type TableRequest,
} from '../shared/data.js'
import { LABEL } from '../shared/document.js'
import type { ChangedRows, ProjectedDocument } from './document.js'
import { Turns } from './turns.js'

const ROWS_PER_PATCH = 4096

export function projectionKey(
  document: ProjectedDocument,
  selection: readonly ProjectionSelection[],
): string {
  return (
    document.key +
    ':' +
    createHash('sha256').update(JSON.stringify(selection)).digest('hex').slice(0, 16)
  )
}

/** Validate the field set and establish reference targets before any references are written. */
export function included(document: ProjectedDocument, selection: readonly ProjectionSelection[]) {
  const tables = new Map<string, readonly string[]>()
  for (const { table, fields } of selection) {
    const definition = document.definition.tables.find((item) => item.name === table)
    if (!definition || !document.tables.has(table)) throw new Error(`Unknown table: ${table}`)
    if (tables.has(table)) throw new Error(`Repeated projection table: ${table}`)
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

/** Stateless, bounded pages. A cursor refers to a single immutable source revision/selection. */
export async function projectionPage(
  document: ProjectedDocument,
  selection: readonly ProjectionSelection[],
  cursor: ProjectionCursor | undefined,
  signal: AbortSignal,
): Promise<ProjectionPage> {
  const tables = included(document, selection)
  let { phase, table: index, offset } = cursor ?? { phase: 'identities', table: 0, offset: 0 }
  if (
    (phase !== 'identities' && phase !== 'fields') ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > tables.length ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new Error('Invalid projection cursor.')
  const turns = new Turns(signal)
  for (;;) {
    await turns.step()
    if (index === tables.length) {
      if (phase === 'fields')
        return { key: projectionKey(document, selection), bytes: new Patch('case').toBytes() }
      phase = 'fields'
      index = 0
      offset = 0
      continue
    }
    const [name, fields] = tables[index]!
    const table = document.tables.get(name)!
    if (offset > table.ids.length) throw new Error('Projection cursor exceeds its table.')
    if (phase === 'fields' && fields.length === 0) {
      index++
      offset = 0
      continue
    }
    let count = Math.min(ROWS_PER_PATCH, table.ids.length - offset)
    if (count === 0 && offset !== 0) throw new Error('Projection cursor is past its last row.')
    let bytes: Uint8Array
    for (;;) {
      const values: Record<string, Fields[string]> = {}
      if (phase === 'fields') {
        for (const name of fields) values[name] = table.read(name, offset, count)
      }
      const patch = new Patch('case')
      bytes =
        count === 0
          ? patch.replace(name, [], values).toBytes()
          : patch.set(name, table.ids.slice(offset, offset + count), values).toBytes()
      signal.throwIfAborted()
      if (bytes.byteLength <= PAGE_BYTES) break
      if (count <= 1) {
        if (bytes.byteLength > ENTRY_BYTES) {
          throw Object.assign(new Error('A projected row exceeds 16 MiB.'), { code: 'limit' })
        }
        break
      }
      count = Math.max(1, Math.floor(count / 2))
      await turns.step()
    }
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
      key: projectionKey(document, selection),
      bytes,
      ...(index < tables.length ? { next: { phase, table: index, offset } } : {}),
    }
  }
}

export async function* project(
  document: ProjectedDocument,
  selection: ReadonlyMap<string, readonly string[]>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const fields = [...selection].map(([table, fields]) => ({ table, fields }))
  let cursor: ProjectionCursor | undefined
  do {
    const page = await projectionPage(document, fields, cursor, signal)
    yield page.bytes
    cursor = page.next
  } while (cursor)
}

export function changedPatch(
  changed: readonly ChangedRows[],
  removed: ReadonlyMap<string, readonly (string | number)[]>,
): Uint8Array {
  const patch = new Patch('case')
  for (const [table, ids] of removed) patch.remove(table, ids)
  for (const change of changed) patch.set(change.table, change.ids, change.fields)
  return patch.toBytes()
}

/** A revision owns its native query dataset and releases it with its parser/cache entry. */
export class CaseQueries {
  readonly data = new Data('case-query')
  readonly #held = new Map<string, Set<string>>()
  #destroyed = false

  constructor(private readonly document: ProjectedDocument) {
    try {
      for (const [name, table] of document.tables) {
        this.data.replace(name, table.ids)
        this.#held.set(name, new Set())
      }
    } catch (error) {
      this.data.destroy()
      throw error
    }
  }

  async #ensure(tableName: string, fields: readonly string[], signal: AbortSignal): Promise<void> {
    const table = this.document.tables.get(tableName)
    const held = this.#held.get(tableName)
    const definition = this.document.definition.tables.find((item) => item.name === tableName)
    if (!table || !held || !definition) throw new Error(`Unknown table: ${tableName}`)
    const missing = [...new Set(fields)].filter((name) => !held.has(name))
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
    for (let offset = 0; offset < table.ids.length; offset += ROWS_PER_PATCH) {
      await turns.step()
      if (this.#destroyed) throw new Error('The query revision was released.')
      const count = Math.min(ROWS_PER_PATCH, table.ids.length - offset)
      const values: Record<string, Fields[string]> = {}
      for (const name of missing) values[name] = table.read(name, offset, count)
      this.data.set(tableName, table.ids.slice(offset, offset + count), values)
    }
    signal.throwIfAborted()
    for (const name of missing) held.add(name)
  }

  async page(request: TableRequest, signal: AbortSignal): Promise<TablePage> {
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 1000
    ) {
      throw new Error('Invalid table page.')
    }
    if (
      request.anchor !== undefined &&
      (request.ids || request.search || request.equal || request.order)
    ) {
      throw new Error('An anchored page requires the unfiltered source order.')
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
    const anchor =
      request.anchor === undefined
        ? -1
        : this.document.tables.get(request.table)!.ids.indexOf(request.anchor)
    const offset = anchor >= 0 ? Math.max(0, anchor - 10) : request.offset
    const query: Query = {
      of: request.table,
      offset,
      limit: request.limit,
      select: Object.fromEntries(request.fields.map((name) => [name, field(name)])),
      ...(request.ids ? { ids: [...request.ids] } : {}),
      ...(filter ? { filter } : {}),
      ...(request.order ? { sort: [[field(request.order.field), request.order.direction]] } : {}),
    }
    const result = this.data.query(query)
    signal.throwIfAborted()
    return { ...result, offset }
  }

  destroy(): void {
    this.#destroyed = true
    this.#held.clear()
    this.data.destroy()
  }
}
