/** A loaded case: its tables as column chunks, the columns views read, and the source bytes. */
import { type Id, reference } from 'latkit'

import { text } from '../platform/bytes.js'
import { sha256 } from '../platform/crypto.js'
import type { CaseDefinition, Entity } from '../shared/document.js'
import { LABEL, NETWORK_POSITION } from '../shared/document.js'
import type { SourceProblem } from '../shared/errors.js'
import { problem } from '../shared/errors.js'
import type { Value } from '../shared/messages.js'
import {
  builder,
  type Chunk,
  chunkAt,
  type Column,
  type DecodeKind,
  deferred,
  isId,
  isValid,
  readColumn,
  rowCount,
  valueAt,
} from './columns.js'
import {
  type ArrayName,
  CASE,
  type Catalog,
  definitionsOf,
  type FieldPlan,
  type Shape,
  withFound,
} from './definition.js'
import type { CaseColumns, CaseTable } from './document.js'
import { charsAt } from './offsets.js'
import {
  ARRAYS,
  BOOLEAN,
  type FoundColumn,
  type IndexedChunk,
  jsonText,
  type Layout,
  type Member,
  NUMBER,
  type Parsed,
  parseNumber,
  Parser,
  type Records,
  type Repeat,
  scan,
  TEXT,
} from './parse.js'
import { STEP_RECORDS, Turns } from './turns.js'

export interface Table {
  readonly shape: Shape
  /** Where each chunk starts, shared by every column; the last entry is the row count. */
  readonly starts: Uint32Array
  readonly ids: Column
  readonly fields: ReadonlyMap<string, Column>
  readonly records: Uint32Array
  /** Per required member that some record lacks, the rows that lack it. */
  readonly lacks: ReadonlyMap<string, Uint32Array>
}

interface FoundField {
  readonly type: string
  readonly field: string
  readonly row: number
}

/** An array's records and each record's `mon` value as a start and end; 0, 0 when absent. */
interface RecordArray extends Records {
  readonly mons: Uint32Array
}

/** Estimated memory per source byte, per field of a record, and per record. */
const SOURCE_BYTES = 4
const FIELD_BYTES = 24
const RECORD_BYTES = 80

/** Hashes the catalog text with the file's hash, so the file is hashed in place, never copied. */
export const versionOf = async (catalog: Catalog, file: Uint8Array): Promise<string> =>
  (await sha256(catalog.text, await sha256(file))).slice(0, 32)

export class Case {
  #columns?: CaseColumns

  /** Parses a case in one pass. Throws for anything GridKit would reject, listing every rejected
   *  record and duplicate id with its position, in file order. */
  static async parse(
    file: Uint8Array,
    catalog: Catalog,
    {
      name = 'Case',
      signal,
      version,
    }: { readonly name?: string; readonly signal?: AbortSignal; readonly version?: string } = {},
  ): Promise<Case> {
    signal?.throwIfAborted()
    const bytes = file
    let layout: Layout
    try {
      ;[version, layout] = await Promise.all([
        version ?? versionOf(catalog, bytes),
        scan(bytes, signal),
      ])
    } catch (error) {
      // Report invalid JSON at the character where it fails.
      const byte = (error as { byte?: number }).byte
      if (byte === undefined) throw error
      throw Object.assign(error as Error, { offset: charsAt(bytes, byte) })
    }
    const parser = new Parser(catalog, bytes, layout)
    const work = new Turns(signal)
    for (const array of ARRAYS) {
      const records = layout.arrays[array]?.starts.length ?? 0
      for (let record = 0; record < records; record++) {
        if ((record & STEP_RECORDS) === 0) await work.step()
        parser.record(array, record)
      }
    }
    const parsed = parser.finish()
    const { kase, repeated } = built(bytes, layout, parsed, catalog, name, version)
    const problems = [...parsed.problems, ...repeated]
    if (!problems.length) return kase
    const placed = problems
      .flatMap(({ message, target: { path } }) => {
        const place = recordSpan(bytes, layout.arrays[path[0] as ArrayName], path[1])
        return place ? [{ message, ...place }] : []
      })
      .sort((a, b) => a.offset - b.offset)
    const [first] = placed
    throw problem('invalid-input', (first ?? problems[0]!).message, {
      ...(first && { offset: first.offset, length: first.length }),
      problems: placed,
    })
  }

  constructor(
    readonly name: string,
    readonly version: string,
    readonly catalog: Catalog,
    /** The catalog's types plus the classes and fields this case adds. */
    readonly definition: CaseDefinition,
    readonly tables: ReadonlyMap<string, Table>,
    readonly file: Uint8Array,
    readonly arrays: Readonly<Partial<Record<ArrayName, RecordArray>>>,
    readonly members: readonly Member[],
    /** Unknown fields outside `extension`, each with its first row. */
    readonly found: readonly FoundField[],
    readonly repeats: readonly Repeat[],
  ) {}

  member(name: string): Member | undefined {
    return this.members.find((member) => member.name === name)
  }

  /** A conservative estimate of the memory the case keeps alive. */
  get bytes(): number {
    let bytes = this.file.byteLength * SOURCE_BYTES
    for (const table of this.tables.values())
      bytes += table.records.length * (FIELD_BYTES * table.fields.size + RECORD_BYTES)
    return bytes
  }

  table(type: string): Table {
    const table = this.tables.get(type)
    if (table === undefined) throw problem('invalid-input', `No type is called ${type}.`)
    return table
  }

  cell(table: Table, field: string, row: number): Value {
    const column = field === table.shape.identity.name ? table.ids : table.fields.get(field)
    if (column === undefined)
      throw problem('invalid-input', `${table.shape.type} has no field ${field}.`)
    const chunk = chunkAt(column.starts, row)
    return valueAt(column.chunks[chunk]!, row - column.starts[chunk]!)
  }

  native(table: Table, row: number): string | number {
    return nativeOf(table, row)
  }

  /** The first row with this id, or -1. */
  rowOf(table: Table, native: string | number): number {
    if (table.shape.identity.type === 'text')
      return typeof native === 'string' ? textIds(table).row(native) : -1
    return typeof native === 'number' && isId(native) ? numberIds(table).row(native) : -1
  }

  entity(table: Table, row: number): Entity {
    return { table: table.shape.type, id: this.native(table, row) }
  }

  locate(entity: Entity): { readonly table: Table; readonly row: number } | null {
    const table = this.tables.get(entity.table)
    const row = table ? this.rowOf(table, entity.id) : -1
    return row < 0 ? null : { table: table!, row }
  }

  columns(): CaseColumns {
    if (this.#columns) return this.#columns
    const tables = new Map<string, CaseTable>()
    for (const [name, table] of this.tables) {
      const ids = identities(table)
      tables.set(name, {
        ids,
        read: (field, offset, count) => {
          if (field === LABEL) return ids.slice(offset, offset + count).map(String)
          // No field positions vertices, so the layout does.
          if (NETWORK_POSITION.includes(field)) return new Float64Array(count).fill(NaN)
          const column = field === table.shape.identity.name ? table.ids : table.fields.get(field)
          if (!column) throw problem('invalid-input', 'Unknown source field: ' + name + '.' + field)
          const values = readColumn(column, offset, count)
          return column.target
            ? reference(
                column.target,
                Array.from(values as Float64Array, (id) => (Number.isFinite(id) ? id : null)),
              )
            : values
        },
      })
    }
    return (this.#columns = { key: this.version, definition: this.definition, tables })
  }
}

/** Builds the case, with a problem for each record that repeats an earlier id. */
function built(
  file: Uint8Array,
  layout: Layout,
  parsed: Parsed,
  catalog: Catalog,
  fallback: string,
  version: string,
): { kase: Case; repeated: SourceProblem[] } {
  const tables = new Map<string, Table>()
  const found: FoundField[] = []
  const filling = parsed.tables.map((read) => {
    const starts = startsOf(read.ids)
    const fields = new Map<string, Column>(
      read.shape.fields.map((field, i) => [
        field.name,
        columnOf(field.decode, read.fields[i]!, starts),
      ]),
    )
    const unknown = read.found.map((column) => foundField(file, column, starts))
    // GridKit leaves `extension` keys to each tool, so an unknown one is not an error.
    for (const { plan, row } of unknown)
      if (plan.path[0] !== 'extension') found.push({ type: read.shape.type, field: plan.name, row })
    const table: Table = {
      shape: unknown.length
        ? withFound(
            read.shape,
            unknown.map(({ plan }) => plan),
          )
        : read.shape,
      starts,
      ids: { kind: read.shape.identity.type, chunks: read.ids, starts },
      fields,
      records: read.records,
      lacks: new Map(
        read.shape.required.flatMap((name, i) =>
          read.lacking[i]!.length ? [[name, read.lacking[i]!] as const] : [],
        ),
      ),
    }
    tables.set(table.shape.type, table)
    return { read, table, fields, unknown }
  })
  // Ports resolve to references once every table exists.
  for (const { read, table, fields } of filling)
    read.shape.ports.forEach((port, i) =>
      fields.set(
        port.name,
        references(read.ports[i]!, table.starts, tables.get(port.definition.target)!),
      ),
    )
  for (const { fields, unknown } of filling)
    for (const { plan, column } of unknown) fields.set(plan.name, column)
  const repeated: SourceProblem[] = []
  for (const table of tables.values()) {
    const { array, identity } = table.shape
    if (array === null) continue
    const named = identity.type === 'text'
    for (const row of (named ? textIds(table) : numberIds(table)).repeated)
      repeated.push({
        code: 'invalid-input',
        message: `Two rows share the ${named ? 'id' : 'number'} ${nativeOf(table, row)}.`,
        target: { kind: 'path', path: [array, table.records[row]!] },
      })
  }
  const arrays: Partial<Record<ArrayName, RecordArray>> = {}
  for (const array of ARRAYS) {
    const records = layout.arrays[array]
    if (records !== undefined) arrays[array] = { ...records, mons: parsed.mons[array]! }
  }
  const named = tables.get(CASE)!.fields.get('header.case_name')
  const name = named && valueAt(named.chunks[0]!, 0)
  const kase = new Case(
    typeof name === 'string' && name !== '' ? name : fallback,
    version,
    catalog,
    definitionsOf(
      [...tables.values()].map((table) => table.shape),
      (table, field) => tables.get(table)?.fields.get(field)?.provided?.() ?? false,
    ),
    tables,
    file,
    arrays,
    layout.members,
    found,
    parsed.repeats,
  )
  return { kase, repeated }
}

function recordSpan(
  file: Uint8Array,
  records: Records | undefined,
  record: unknown,
): { offset: number; length: number } | undefined {
  if (!records || typeof record !== 'number' || !(record < records.starts.length)) return undefined
  const start = records.starts[record]!
  const offset = charsAt(file, start)
  return { offset, length: charsAt(file, records.ends[record]!) - offset }
}

function columnOf(kind: DecodeKind, parts: readonly IndexedChunk[], starts: Uint32Array): Column {
  const decoded = deferred(() => parts.map((part) => part.read()))
  return {
    kind,
    starts,
    provided: () => parts.some((part) => part.provided()),
    get chunks() {
      return decoded()
    },
    // As table rows.
    wrong: deferred(() =>
      parts.flatMap((part, c) => Array.from(part.wrong(), (at) => starts[c]! + at)),
    ),
  }
}

/** An unknown member as a field: number, boolean or text when uniform, otherwise raw JSON text. */
function foundField(
  file: Uint8Array,
  { path, rows, spans, kinds }: FoundColumn,
  starts: Uint32Array,
): { plan: FieldPlan; column: Column; row: number } {
  const type: DecodeKind =
    kinds === NUMBER
      ? 'number'
      : kinds === BOOLEAN
        ? 'boolean'
        : kinds === TEXT || kinds === 0
          ? 'text'
          : 'json'
  // Quote keys that contain a dot, so they are never read as a path.
  const name = path.map((key) => (key.includes('.') ? JSON.stringify(key) : key)).join('.')
  const cell = (value: number, end: number): Value => {
    if (file[value] === 0x6e) return null
    if (type === 'number') return parseNumber(file, value, end)
    if (type === 'boolean') return file[value] === 0x74
    if (type === 'text') return jsonText(file, value + 1, end - 1)
    return text(file, value, end)
  }
  const decode = deferred(() => {
    let at = 0
    return Array.from({ length: starts.length - 1 }, (_, chunk) => {
      const target = builder(type)
      for (let row = starts[chunk]!; row < starts[chunk + 1]!; row++)
        if (rows[at] === row) {
          target.push(cell(spans[2 * at]!, spans[2 * at + 1]!))
          at++
        } else target.push(null)
      return target.finish()
    })
  })
  return {
    plan: {
      name,
      decode: type,
      role: 'value',
      path,
      definition: { name, kind: type, label: name },
    },
    column: {
      kind: type,
      starts,
      get chunks() {
        return decode()
      },
    },
    row: rows[0]!,
  }
}

function startsOf(chunks: readonly Chunk[]): Uint32Array {
  const starts = new Uint32Array(chunks.length + 1)
  chunks.forEach((chunk, i) => (starts[i + 1] = starts[i]! + chunk.length))
  return starts
}

/** A port column. A value that names no row of `target` becomes empty and counts as wrong. */
function references(parts: readonly IndexedChunk[], starts: Uint32Array, target: Table): Column {
  const decode = deferred(() => {
    const ids = numberIds(target)
    const wrong: number[] = []
    const chunks = parts.map((part, c) => {
      const values = (part.read() as Float64Array).slice()
      const invalid = new Set(part.wrong())
      for (let at = 0; at < values.length; at++)
        if (Number.isFinite(values[at]) && ids.row(values[at]!) < 0) {
          values[at] = NaN
          invalid.add(at)
        }
      for (const at of [...invalid].sort((a, b) => a - b)) wrong.push(starts[c]! + at)
      return values
    })
    return { chunks, wrong }
  })
  return {
    kind: 'reference',
    target: target.shape.type,
    starts,
    get chunks() {
      return decode().chunks
    },
    wrong: () => decode().wrong,
  }
}

function nativeOf(table: Table, row: number): string | number {
  const chunk = chunkAt(table.starts, row)
  return table.ids.chunks[chunk]![row - table.starts[chunk]!] as Id
}

const nativeIds = new WeakMap<Column, readonly Id[]>()
function identities(table: Table): readonly Id[] {
  let ids = nativeIds.get(table.ids)
  if (!ids) {
    ids = table.ids.chunks.flatMap((chunk) =>
      Array.from({ length: chunk.length }, (_, at) => chunk[at] as Id),
    )
    nativeIds.set(table.ids, ids)
  }
  return ids
}

const TEXT_IDS = new WeakMap<Column, TextIds>()
const NUMBER_IDS = new WeakMap<Column, NumberIds>()

function textIds(table: Table): TextIds {
  let ids = TEXT_IDS.get(table.ids)
  if (ids === undefined) TEXT_IDS.set(table.ids, (ids = new TextIds(table)))
  return ids
}

function numberIds(table: Table): NumberIds {
  let ids = NUMBER_IDS.get(table.ids)
  if (ids === undefined) NUMBER_IDS.set(table.ids, (ids = new NumberIds(table)))
  return ids
}

/** Maps text ids to the first row with each id. */
class TextIds {
  readonly #rows = new Map<string, number>()
  /** Ascending rows whose id an earlier row already has. */
  readonly repeated: number[] = []

  constructor(table: Table) {
    table.ids.chunks.forEach((chunk, index) => {
      for (let at = 0; at < chunk.length; at++) {
        const value = chunk[at]
        if (typeof value !== 'string') continue
        const row = table.starts[index]! + at
        if (this.#rows.has(value)) this.repeated.push(row)
        else this.#rows.set(value, row)
      }
    })
  }

  row(id: string): number {
    return this.#rows.get(id) ?? -1
  }
}

/** Maps numeric ids to the first row with each id: a dense array of row + 1 at key - min, or sorted
 *  keys with their rows. */
class NumberIds {
  readonly #min: number
  readonly #dense: Uint32Array | null
  readonly #keys: Float64Array
  readonly #rows: Uint32Array
  readonly repeated: number[] = []

  constructor(table: Table) {
    const column = table.ids
    const count = rowCount(column.starts)
    const keys = new Float64Array(count)
    const rows = new Uint32Array(count)
    let size = 0
    let min = Infinity
    let max = -Infinity
    column.chunks.forEach((value, index) => {
      const chunk = value as Float64Array
      for (let at = 0; at < chunk.length; at++) {
        if (!isValid(chunk, at)) continue
        const key = chunk[at]!
        keys[size] = key
        rows[size++] = column.starts[index]! + at
        if (key < min) min = key
        if (key > max) max = key
      }
    })
    this.#min = min
    if (size > 0 && max - min < 4 * size + 64) {
      const dense = new Uint32Array(max - min + 1)
      for (let i = 0; i < size; i++)
        if (dense[keys[i]! - min] === 0) dense[keys[i]! - min] = rows[i]! + 1
        else this.repeated.push(rows[i]!)
      this.#dense = dense
      this.#keys = new Float64Array(0)
      this.#rows = new Uint32Array(0)
      return
    }
    // Sort by key, then by row, so the first row of each key is kept.
    const order = Uint32Array.from({ length: size }, (_, i) => i).sort(
      (a, b) => keys[a]! - keys[b]! || a - b,
    )
    this.#dense = null
    this.#keys = new Float64Array(size)
    this.#rows = new Uint32Array(size)
    let kept = 0
    for (const i of order) {
      if (kept > 0 && this.#keys[kept - 1] === keys[i]) {
        this.repeated.push(rows[i]!)
        continue
      }
      this.#keys[kept] = keys[i]!
      this.#rows[kept++] = rows[i]!
    }
    this.#keys = this.#keys.subarray(0, kept)
    this.#rows = this.#rows.subarray(0, kept)
    this.repeated.sort((a, b) => a - b)
  }

  row(key: number): number {
    if (this.#dense !== null) {
      const at = key - this.#min
      return at >= 0 && at < this.#dense.length ? this.#dense[at]! - 1 : -1
    }
    let low = 0
    let high = this.#keys.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const found = this.#keys[middle]!
      if (found === key) return this.#rows[middle]!
      if (found < key) low = middle + 1
      else high = middle - 1
    }
    return -1
  }
}
