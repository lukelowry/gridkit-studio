/** Indexes a case's JSON bytes once and decodes columns on demand, keeping unknown members. */
import { text } from '../platform/bytes.js'
import type { SourceProblem } from '../shared/errors.js'
import { problem } from '../shared/errors.js'
import type { DecodeKind } from './columns.js'
import {
  type Builder,
  builder,
  type Chunk,
  CHUNK_ROWS,
  deferred,
  grown,
  hash,
  isId,
  NumericBuilder,
  type TextBuilder,
} from './columns.js'
import {
  type ArrayName,
  BUS_CODE,
  CASE,
  CASE_ROW,
  type Catalog,
  CLASS,
  DEVICE_CODES,
  MON,
  type Shape,
  SIGNAL_CODE,
  unknownShape,
} from './definition.js'
import { STEP_RECORDS, Turns } from './turns.js'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_OBJECT = 0x7b
const CLOSE_OBJECT = 0x7d
const OPEN_ARRAY = 0x5b
const CLOSE_ARRAY = 0x5d
const NULL_START = 0x6e
const TRUE_START = 0x74
const FALSE_START = 0x66
const UTF8 = new TextEncoder()

export const ARRAYS: readonly ArrayName[] = ['buses', 'signals', 'devices']

/** A top-level member: offsets of its key's opening quote, its value, and just past the value. */
export interface Member {
  readonly name: string
  readonly start: number
  readonly value: number
  readonly end: number
}

/** Byte offsets of an array's brackets and of each record's start and end. */
export interface Records {
  readonly open: number
  readonly close: number
  readonly starts: Uint32Array
  readonly ends: Uint32Array
}

/** A key repeated within one object, where GridKit keeps the later value. Spans its quotes. */
export interface Repeat {
  readonly type: string
  readonly row: number
  readonly start: number
  readonly end: number
}

export interface Layout {
  /** Top-level members in file order, keeping only the last of each name. */
  readonly members: readonly Member[]
  readonly arrays: Readonly<Partial<Record<ArrayName, Records>>>
  readonly repeats: readonly Repeat[]
}

/** Validates the whole file as JSON while locating top-level members and array records. */
export async function scan(bytes: Uint8Array, signal = AbortSignal.any([])): Promise<Layout> {
  const work = new Turns(signal)
  // Offsets are stored as signed 32-bit integers, with -1 for a missing value.
  if (bytes.length > 0x7fffffff) throw problem('limit', 'A case file must be smaller than 2 GiB.')
  let i = skipSpace(bytes, 0)
  expect(bytes, i, OPEN_OBJECT, 'a case object')
  const members: Member[] = []
  const repeats: Repeat[] = []
  const arrays = new Map<ArrayName, Records>()
  i = skipSpace(bytes, i + 1)
  while (bytes[i] !== CLOSE_OBJECT) {
    expect(bytes, i, QUOTE, 'a member name')
    const start = i
    const keyEnd = checkString(bytes, i)
    const name = keyOf(bytes, start, keyEnd)
    i = skipSpace(bytes, keyEnd)
    expect(bytes, i, COLON, 'a colon')
    const value = skipSpace(bytes, i + 1)
    const array = ARRAYS.find((each) => each === name)
    let end: number
    if (array && bytes[value] === OPEN_ARRAY) {
      const records = { open: value, ...(await recordsFrom(bytes, value + 1, work)) }
      arrays.set(array, records)
      end = records.close + 1
    } else {
      // A later non-array value replaces the array.
      if (array) arrays.delete(array)
      end = checkValue(bytes, value)
    }
    const before = members.findIndex((member) => member.name === name)
    if (before >= 0) {
      members.splice(before, 1)
      repeats.push({ type: CASE, row: 0, start, end: keyEnd })
    }
    members.push({ name, start, value, end })
    i = skipSpace(bytes, end)
    if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
    else if (bytes[i] !== CLOSE_OBJECT) malformed(i, 'a comma or the end of the case')
  }
  if (skipSpace(bytes, i + 1) !== bytes.length) malformed(i + 1, 'the end of the file')
  return { members, arrays: Object.fromEntries(arrays), repeats }
}

async function recordsFrom(
  bytes: Uint8Array,
  from: number,
  work: Turns,
): Promise<{ close: number; starts: Uint32Array; ends: Uint32Array }> {
  let starts: Uint32Array = new Uint32Array(1024)
  let ends: Uint32Array = new Uint32Array(1024)
  let count = 0
  const done = (close: number) => ({
    close,
    starts: starts.slice(0, count),
    ends: ends.slice(0, count),
  })
  let i = skipSpace(bytes, from)
  if (bytes[i] === CLOSE_ARRAY) return done(i)
  for (;;) {
    if ((count & STEP_RECORDS) === 0) await work.step()
    const end = checkValue(bytes, i)
    if (count === starts.length) {
      starts = grown(starts)
      ends = grown(ends)
    }
    starts[count] = i
    ends[count++] = end
    i = skipSpace(bytes, end)
    if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
    else if (bytes[i] === CLOSE_ARRAY) return done(i)
    else malformed(i, 'a comma or the end of the array')
  }
}

/** Validates the strict JSON value at `start` and returns the offset past it. Never recurses. */
function checkValue(bytes: Uint8Array, start: number): number {
  /** Open containers: 1 for an object, 0 for an array. */
  const objects: number[] = []
  let i = start
  const key = (): number => {
    expect(bytes, i, QUOTE, 'a member name')
    const colon = skipSpace(bytes, checkString(bytes, i))
    expect(bytes, colon, COLON, 'a colon')
    return colon + 1
  }
  for (;;) {
    i = skipSpace(bytes, i)
    const first = bytes[i]
    if (first === OPEN_OBJECT || first === OPEN_ARRAY) {
      const object = first === OPEN_OBJECT
      i = skipSpace(bytes, i + 1)
      if (bytes[i] !== (object ? CLOSE_OBJECT : CLOSE_ARRAY)) {
        objects.push(object ? 1 : 0)
        if (object) i = key()
        continue
      }
      i++
    } else if (first === QUOTE) i = checkString(bytes, i)
    else if (first === 0x74) i = checkWord(bytes, i, TRUE)
    else if (first === 0x66) i = checkWord(bytes, i, FALSE)
    else if (first === 0x6e) i = checkWord(bytes, i, NULL)
    else i = checkNumber(bytes, i)
    // After a value: move to the next element, or close containers until one continues.
    for (;;) {
      if (!objects.length) return i
      i = skipSpace(bytes, i)
      const object = objects.at(-1) === 1
      if (bytes[i] === COMMA) {
        i = skipSpace(bytes, i + 1)
        if (object) i = key()
        break
      }
      if (bytes[i] !== (object ? CLOSE_OBJECT : CLOSE_ARRAY))
        malformed(i, object ? 'a comma or the end of an object' : 'a comma or the end of an array')
      i++
      objects.pop()
    }
  }
}

const TRUE = UTF8.encode('true')
const FALSE = UTF8.encode('false')
const NULL = UTF8.encode('null')

function checkWord(bytes: Uint8Array, i: number, word: Uint8Array): number {
  for (let k = 0; k < word.length; k++) if (bytes[i + k] !== word[k]) malformed(i, 'a value')
  return i + word.length
}

function checkNumber(bytes: Uint8Array, i: number): number {
  const start = i
  const digits = () => {
    const from = i
    while (bytes[i]! >= 0x30 && bytes[i]! <= 0x39) i++
    if (i === from) malformed(start, 'a value')
  }
  if (bytes[i] === 0x2d) i++
  if (bytes[i] === 0x30) i++
  else digits()
  if (bytes[i] === 0x2e) {
    i++
    digits()
  }
  if (bytes[i] === 0x65 || bytes[i] === 0x45) {
    i++
    if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++
    digits()
  }
  return i
}

function checkString(bytes: Uint8Array, i: number): number {
  for (let at = i + 1; at < bytes.length; at++) {
    const c = bytes[at]!
    if (c === QUOTE) return at + 1
    if (c < 0x20) malformed(at, 'a string without control characters')
    if (c !== BACKSLASH) continue
    const escaped = bytes[++at]
    if (escaped === 0x75) {
      for (let k = 1; k <= 4; k++) if (!isHex(bytes[at + k])) malformed(at, 'four hex digits')
      at += 4
    } else if (!ESCAPES.has(escaped!)) malformed(at, 'an escape JSON has')
  }
  return malformed(i, 'a closed string')
}

const ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74])

const isHex = (c: number | undefined) =>
  c !== undefined && ((c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x66))

/** The offset just past the JSON value at `i`, which `scan` has already validated. */
function skipValue(bytes: Uint8Array, i: number): number {
  const first = bytes[i]
  if (first === QUOTE) return stringEnd(bytes, i)
  if (first === OPEN_OBJECT || first === OPEN_ARRAY) {
    let depth = 0
    for (let at = i; at < bytes.length; at++) {
      const c = bytes[at]!
      if (c === QUOTE) at = stringEnd(bytes, at) - 1
      else if (c === OPEN_OBJECT || c === OPEN_ARRAY) depth++
      else if ((c === CLOSE_OBJECT || c === CLOSE_ARRAY) && --depth === 0) return at + 1
    }
    return malformed(i, 'a closed value')
  }
  let at = i
  while (at < bytes.length) {
    const c = bytes[at]!
    if (c === COMMA || c === CLOSE_OBJECT || c === CLOSE_ARRAY || c <= 0x20) break
    at++
  }
  return at === i ? malformed(i, 'a value') : at
}

function stringEnd(bytes: Uint8Array, i: number): number {
  for (let at = i + 1; at < bytes.length; at++) {
    const c = bytes[at]
    if (c === BACKSLASH) at++
    else if (c === QUOTE) return at + 1
  }
  return malformed(i, 'a closed string')
}

function skipSpace(bytes: Uint8Array, i: number): number {
  while (i < bytes.length) {
    const c = bytes[i]
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break
    i++
  }
  return i
}

/** One object's members, four offsets each: key text start and end, value start and end. */
export class Members {
  spans = new Int32Array(256)

  read(bytes: Uint8Array, open: number): number {
    expect(bytes, open, OPEN_OBJECT, 'an object')
    let count = 0
    let i = skipSpace(bytes, open + 1)
    while (bytes[i] !== CLOSE_OBJECT) {
      expect(bytes, i, QUOTE, 'a member name')
      const keyEnd = stringEnd(bytes, i)
      const colon = skipSpace(bytes, keyEnd)
      expect(bytes, colon, COLON, 'a colon')
      const value = skipSpace(bytes, colon + 1)
      const end = skipValue(bytes, value)
      const at = 4 * count++
      if (at + 4 > this.spans.length) this.spans = grown(this.spans)
      const spans = this.spans
      spans[at] = i + 1
      spans[at + 1] = keyEnd - 1
      spans[at + 2] = value
      spans[at + 3] = end
      i = skipSpace(bytes, end)
      if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
      else if (bytes[i] !== CLOSE_OBJECT) malformed(i, 'a comma or the end of the object')
    }
    return count
  }

  /** The last of `count` members named `key`, which GridKit reads, or -1. */
  find(bytes: Uint8Array, count: number, key: string): number {
    for (let m = count - 1; m >= 0; m--)
      if (jsonText(bytes, this.spans[4 * m]!, this.spans[4 * m + 1]!) === key) return m
    return -1
  }
}

const keyOf = (bytes: Uint8Array, start: number, end: number): string =>
  jsonText(bytes, start + 1, end - 1)

/** Decodes the JSON string content at `[start, end)`, quotes excluded. */
export function jsonText(bytes: Uint8Array, start: number, end: number): string {
  const raw = text(bytes, start, end)
  return raw.includes('\\') ? (JSON.parse('"' + raw + '"') as string) : raw
}

function expect(bytes: Uint8Array, i: number, code: number, what: string): void {
  if (bytes[i] !== code) malformed(i, what)
}

function malformed(at: number, what: string): never {
  throw Object.assign(problem('invalid-input', `Invalid JSON: expected ${what}.`), { byte: at })
}

/** A column chunk that keeps each row's value offsets and decodes on first read. */
export interface IndexedChunk {
  provided(): boolean
  read(): Chunk
  /** Ascending rows whose non-null value fails to decode, found without decoding when possible. */
  wrong(): Uint32Array
}

/** Bit flags for the JSON value kinds an unknown member has. `null` sets none. */
export const TEXT = 1
export const BOOLEAN = 2
export const NUMBER = 4
const NESTED = 8

/** An unknown member as a column: the ascending rows that have it, and their value spans. */
export interface FoundColumn {
  readonly path: readonly string[]
  readonly rows: Uint32Array
  readonly spans: Int32Array
  readonly kinds: number
}

interface ParsedTable {
  readonly shape: Shape
  readonly ids: readonly Chunk[]
  readonly fields: readonly (readonly IndexedChunk[])[]
  readonly ports: readonly (readonly IndexedChunk[])[]
  readonly records: Uint32Array
  readonly found: readonly FoundColumn[]
  /** Per required member, the rows that lack it. */
  readonly lacking: readonly Uint32Array[]
}

export interface Parsed {
  /** The catalog's tables in catalog order, then unknown classes in order of first record, then the
   *  case's own table. */
  readonly tables: readonly ParsedTable[]
  /** Per array, each record's `mon` value as a start and end offset; 0, 0 when absent. */
  readonly mons: Readonly<Partial<Record<ArrayName, Uint32Array>>>
  readonly problems: readonly SourceProblem[]
  readonly repeats: readonly Repeat[]
}

const NONE = -1

const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i)

/** A fixed key set matched against raw key bytes without allocating strings. */
class Keys {
  readonly #slots: Int32Array
  readonly #names: readonly Uint8Array[]

  constructor(names: readonly string[]) {
    this.#names = names.map((name) => UTF8.encode(name))
    let size = 8
    while (size < names.length * 2) size *= 2
    this.#slots = new Int32Array(size)
    this.#names.forEach((name, i) => {
      let slot = hash(name, 0, name.length) & (size - 1)
      while (this.#slots[slot] !== 0) slot = (slot + 1) & (size - 1)
      this.#slots[slot] = i + 1
    })
  }

  find(bytes: Uint8Array, start: number, end: number): number {
    for (let i = start; i < end; i++)
      if (bytes[i] === BACKSLASH) {
        const spelled = UTF8.encode(jsonText(bytes, start, end))
        return this.#find(spelled, 0, spelled.length)
      }
    return this.#find(bytes, start, end)
  }

  #find(bytes: Uint8Array, start: number, end: number): number {
    const mask = this.#slots.length - 1
    for (
      let slot = hash(bytes, start, end) & mask;
      this.#slots[slot] !== 0;
      slot = (slot + 1) & mask
    ) {
      const name = this.#names[this.#slots[slot]! - 1]!
      if (name.length !== end - start) continue
      let same = true
      for (let i = 0; i < name.length && same; i++) same = name[i] === bytes[start + i]
      if (same) return this.#slots[slot]! - 1
    }
    return -1
  }
}

const CLASS_KEY = new Keys([CLASS])

/** Roles of top-level members that are not fields. From GROUP down, `GROUP - role` is a group. */
const ID = -1
const LIST = -2
const TABLE = -3
const OTHER = -4
const GROUP = -5

/** A chunk over each row's value span in `bytes` (start and end, -1 when missing). It decodes on
 *  first read and then drops the spans and the file bytes. A port's value is the row it names. */
function lazyColumn(
  bytes: Uint8Array,
  spans: Int32Array,
  type: DecodeKind,
  port: boolean,
): IndexedChunk {
  // Kept apart so the decoded chunk does not retain the file bytes.
  let unread: { bytes: Uint8Array; spans: Int32Array } | undefined = { bytes, spans }
  const decode = deferred(() => {
    const { bytes, spans: own } = unread!
    unread = undefined
    const rows = own.length / 2
    const target = builder(type)
    const wrong: number[] = []
    for (let row = 0; row < rows; row++) {
      const value = own[2 * row]!
      const end = own[2 * row + 1]!
      let read: boolean
      if (port) {
        const number = value < 0 ? NaN : parseNumber(bytes, value, end)
        read = isId(number)
        if (read) (target as NumericBuilder).pushNumber(number)
      } else read = value >= 0 && decodeInto(bytes, target, type, value, end)
      if (read) continue
      target.push(null)
      if (value >= 0 && bytes[value] !== NULL_START) wrong.push(row)
    }
    return { chunk: target.finish(), wrong: Uint32Array.from(wrong) }
  })
  let wrongFromBytes: Uint32Array | undefined
  return {
    // Gives the same answer before and after decoding.
    provided: () =>
      unread
        ? unread.spans.some(
            (at, index) => index % 2 === 0 && at >= 0 && unread!.bytes[at] !== NULL_START,
          )
        : decode().wrong.length > 0 ||
          decode().chunk.some(
            (value) => value !== null && (typeof value !== 'number' || Number.isFinite(value)),
          ),
    read: () => decode().chunk,
    wrong: () =>
      (wrongFromBytes ??=
        unread && !port ? wrongOf(unread.bytes, unread.spans, type) : undefined) ?? decode().wrong,
  }
}

/** Rows whose non-null value does not match `type`, judged from its first byte, which validated
 *  JSON makes distinct per kind. Undefined for types that need a full decode. */
function wrongOf(bytes: Uint8Array, spans: Int32Array, type: DecodeKind): Uint32Array | undefined {
  if (type !== 'number' && type !== 'text' && type !== 'boolean') return undefined
  const wrong: number[] = []
  for (let row = 0; 2 * row < spans.length; row++) {
    const value = spans[2 * row]!
    if (value < 0) continue
    const first = bytes[value]!
    if (first === NULL_START) continue
    if (
      type === 'text'
        ? first !== QUOTE
        : type === 'boolean'
          ? first !== TRUE_START && first !== FALSE_START
          : !(
              (first === 0x2d || (first >= 0x30 && first <= 0x39)) &&
              finite(bytes, value, spans[2 * row + 1]!)
            )
    )
      wrong.push(row)
  }
  return Uint32Array.from(wrong)
}

/** Whether the JSON number at [start, end) is finite as a double. One under 300 characters without
 *  an exponent always is, so only the rest are parsed. */
function finite(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start < 300) {
    let i = start
    while (i < end && bytes[i] !== 0x65 && bytes[i] !== 0x45) i++
    if (i === end) return true
  }
  return Number.isFinite(parseNumber(bytes, start, end))
}

const keyHash = (key: Uint8Array, start: number, end: number, group: number): number =>
  hash(key, start, end) ^ Math.imul(group + 2, 0x9e3779b1)

/** Builds a FoundColumn as an unknown member's values are read. */
class FoundColumnBuilder {
  #rows = new Uint32Array(16)
  #spans = new Int32Array(32)
  #count = 0
  #kinds = 0

  constructor(
    readonly path: readonly string[],
    /** The decoded key, and the group it is under (-1 for a top-level member). */
    readonly key: Uint8Array,
    readonly group: number,
  ) {}

  get written(): boolean {
    return this.#count > 0
  }

  /** Records `row`'s value. Returns false when it replaces one from the same object. */
  push(row: number, bytes: Uint8Array, value: number, end: number): boolean {
    const again = this.#count > 0 && this.#rows[this.#count - 1] === row
    if (!again) {
      if (this.#count === this.#rows.length) {
        this.#rows = grown(this.#rows)
        this.#spans = grown(this.#spans)
      }
      this.#rows[this.#count++] = row
    }
    this.#spans[2 * this.#count - 2] = value
    this.#spans[2 * this.#count - 1] = end
    // JSON is already validated, so the first byte identifies the value's kind.
    const first = bytes[value]!
    if (first === QUOTE) this.#kinds |= TEXT
    else if (first === TRUE_START || first === FALSE_START) this.#kinds |= BOOLEAN
    else if (first === 0x2d || (first >= 0x30 && first <= 0x39)) this.#kinds |= NUMBER
    else if (first !== NULL_START) this.#kinds |= NESTED
    return !again
  }

  drop(row: number): void {
    if (this.#count > 0 && this.#rows[this.#count - 1] === row) this.#count--
  }

  finish(): FoundColumn {
    return {
      path: this.path,
      rows: this.#rows.slice(0, this.#count),
      spans: this.#spans.slice(0, 2 * this.#count),
      kinds: this.#kinds,
    }
  }
}

/** Collects one table's ids, value spans, unknown members and missing members. */
class TableBuilder {
  /** Top-level keys, their roles (a field slot or a negative role), and required index or -1. */
  readonly keys: Keys
  readonly roles: Int32Array
  readonly required: Int32Array
  /** Per top-level key, the number of the object that last had it, to detect repeated keys. */
  readonly marks: Int32Array
  readonly present: Int32Array
  /** Per group, its field and port keys, their slots (ports after fields), and repeat marks. */
  readonly groups: readonly {
    readonly keys: Keys
    readonly slots: Int32Array
    readonly marks: Int32Array
  }[]
  readonly width: number
  ids!: Builder
  count = 0
  #spans!: Int32Array
  #staged = 0
  #records = new Uint32Array(256)
  readonly #lacking: number[][]
  readonly #found: FoundColumnBuilder[] = []
  /** Open-addressed index into #found by key hash: index + 1, or 0 for an empty slot. */
  #foundIndex = new Int32Array(64)
  readonly #chunks: { ids: Chunk[]; fields: IndexedChunk[][]; ports: IndexedChunk[][] }

  constructor(
    readonly shape: Shape,
    readonly bytes: Uint8Array,
  ) {
    const { fields, ports, groups, required } = shape
    this.width = fields.length + ports.length
    const names: string[] = []
    const roles: number[] = []
    const add = (name: string, role: number) => {
      names.push(name)
      roles.push(role)
    }
    if (shape.array !== null) add(shape.identity.name, ID)
    if (shape.kind === 'bus' || shape.kind === 'device') add(MON, LIST)
    if (shape.kind === 'device') add(CLASS, TABLE)
    fields.forEach((field, slot) => {
      if (field.path.length === 1) add(field.path[0]!, slot)
    })
    groups.forEach((group, index) => add(group, GROUP - index))
    for (const name of required) if (!names.includes(name)) add(name, OTHER)
    this.keys = new Keys(names)
    this.roles = Int32Array.from(roles)
    this.required = Int32Array.from(names, (name) => required.indexOf(name))
    this.marks = new Int32Array(names.length)
    this.present = new Int32Array(required.length)
    this.groups = groups.map((group) => {
      const under: string[] = []
      const slots: number[] = []
      fields.forEach((field, slot) => {
        if (field.path.length !== 2 || field.path[0] !== group) return
        under.push(field.path[1]!)
        slots.push(slot)
      })
      ports.forEach((port, index) => {
        if (port.path[0] !== group) return
        under.push(port.path[1]!)
        slots.push(fields.length + index)
      })
      return {
        keys: new Keys(under),
        slots: Int32Array.from(slots),
        marks: new Int32Array(under.length),
      }
    })
    this.#lacking = required.map(() => [])
    this.#chunks = { ids: [], fields: fields.map(() => []), ports: ports.map(() => []) }
    this.#startChunk()
  }

  next(record: number): void {
    if (this.#staged === CHUNK_ROWS) this.#flush()
    if (++this.#staged * 2 * this.width > this.#spans.length) this.#spans = grown(this.#spans)
    if (this.count === this.#records.length) this.#records = grown(this.#records)
    this.#records[this.count++] = record
  }

  /** Stores the row's value spans. Only the id is decoded right away. */
  stage(slots: Int32Array): void {
    this.#spans.set(slots.subarray(0, 2 * this.width), (this.#staged - 1) * 2 * this.width)
  }

  lack(row: number, object: number): void {
    for (let at = 0; at < this.present.length; at++)
      if (this.present[at] !== object) this.#lacking[at]!.push(row)
  }

  /** The column of an unknown key under `group` (-1 for top level), made on first use. */
  find(group: number, bytes: Uint8Array, start: number, end: number): FoundColumnBuilder {
    let key: Uint8Array = bytes
    let spelled: string | undefined
    for (let i = start; i < end; i++)
      if (bytes[i] === BACKSLASH) {
        spelled = jsonText(bytes, start, end)
        key = UTF8.encode(spelled)
        start = 0
        end = key.length
        break
      }
    let mask = this.#foundIndex.length - 1
    let slot = keyHash(key, start, end, group) & mask
    for (; this.#foundIndex[slot] !== 0; slot = (slot + 1) & mask) {
      const found = this.#found[this.#foundIndex[slot]! - 1]!
      if (found.group !== group || found.key.length !== end - start) continue
      let same = true
      for (let i = 0; i < found.key.length && same; i++) same = found.key[i] === key[start + i]
      if (same) return found
    }
    const name = spelled ?? text(bytes, start, end)
    const found = new FoundColumnBuilder(
      group < 0 ? [name] : [this.shape.groups[group]!, name],
      // Copied so the column does not retain the file bytes.
      Uint8Array.from(key.subarray(start, end)),
      group,
    )
    this.#foundIndex[slot] = this.#found.push(found)
    if (this.#found.length * 2 > this.#foundIndex.length) {
      this.#foundIndex = new Int32Array(this.#foundIndex.length * 2)
      mask = this.#foundIndex.length - 1
      this.#found.forEach((each, index) => {
        let at = keyHash(each.key, 0, each.key.length, each.group) & mask
        while (this.#foundIndex[at] !== 0) at = (at + 1) & mask
        this.#foundIndex[at] = index + 1
      })
    }
    return found
  }

  forget(group: number, row: number): void {
    for (const found of this.#found) if (found.group === group) found.drop(row)
  }

  finish(): ParsedTable {
    this.#flush()
    return {
      shape: this.shape,
      ...this.#chunks,
      records: this.#records.slice(0, this.count),
      // A member whose only value was dropped by a repeated group is left out.
      found: this.#found.filter((found) => found.written).map((found) => found.finish()),
      lacking: this.#lacking.map((rows) => Uint32Array.from(rows)),
    }
  }

  #flush(): void {
    if (this.#staged === 0) return
    this.#chunks.ids.push(this.ids.finish())
    const { fields, ports } = this.shape
    fields.forEach((field, i) =>
      this.#chunks.fields[i]!.push(lazyColumn(this.bytes, this.#slot(i), field.decode, false)),
    )
    ports.forEach((_, i) =>
      this.#chunks.ports[i]!.push(
        lazyColumn(this.bytes, this.#slot(fields.length + i), 'unsigned', true),
      ),
    )
    this.#startChunk()
  }

  #slot(slot: number): Int32Array {
    const spans = new Int32Array(2 * this.#staged)
    const width = 2 * this.width
    for (let row = 0, at = 2 * slot; row < this.#staged; row++, at += width) {
      spans[2 * row] = this.#spans[at]!
      spans[2 * row + 1] = this.#spans[at + 1]!
    }
    return spans
  }

  #startChunk(): void {
    this.ids = builder(this.shape.identity.type)
    this.#spans = new Int32Array(256 * 2 * this.width)
    this.#staged = 0
  }
}

/** Reads a case's records into tables, one record at a time in file order. */
export class Parser {
  readonly #bytes: Uint8Array
  readonly #layout: Layout
  readonly #own: Shape
  readonly #classes: Keys
  /** Table shapes by code: the catalog's, then unknown classes in the order found. */
  readonly #shapes: Shape[]
  readonly #unknown = new Map<string, number>()
  readonly #tables: (TableBuilder | undefined)[] = []
  readonly #members = new Members()
  readonly #nested = new Members()
  #slots = new Int32Array(2 * 64)
  #id = -1
  #idEnd = -1
  /** Objects read so far. Each object's number marks the keys it contains. */
  #objects = 0
  readonly #mons: Partial<Record<ArrayName, Uint32Array>> = {}
  readonly #problems: SourceProblem[] = []
  readonly #repeats: Repeat[]

  constructor(catalog: Catalog, bytes: Uint8Array, layout: Layout) {
    this.#bytes = bytes
    this.#layout = layout
    this.#own = catalog.shapes.get(CASE)!
    this.#classes = new Keys(catalog.codes.map((shape) => shape.type))
    this.#shapes = [...catalog.codes]
    this.#repeats = [...layout.repeats]
    for (const array of ARRAYS) {
      const records = layout.arrays[array]
      if (records) this.#mons[array] = new Uint32Array(2 * records.starts.length)
    }
  }

  record(array: ArrayName, record: number): void {
    const bytes = this.#bytes
    const open = this.#layout.arrays[array]!.starts[record]!
    // GridKit rejects a record that is not an object.
    if (bytes[open] !== OPEN_OBJECT)
      return this.#problem(record, `Each of the case's ${array} is written as an object.`, array)
    const count = this.#members.read(bytes, open)
    const spans = this.#members.spans
    const code =
      array === 'buses'
        ? BUS_CODE
        : array === 'signals'
          ? SIGNAL_CODE
          : this.#classOf(count, record)
    if (code === NONE) return
    const table = (this.#tables[code] ??= new TableBuilder(this.#shapes[code]!, bytes))
    const slots = this.#stage(table)
    const row = table.count
    const object = ++this.#objects
    for (let m = 0; m < count; m++) {
      const keyStart = spans[4 * m]!
      const keyEnd = spans[4 * m + 1]!
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      const key = table.keys.find(bytes, keyStart, keyEnd)
      if (key < 0) {
        if (!table.find(-1, bytes, keyStart, keyEnd).push(row, bytes, value, end))
          this.#repeat(table, row, keyStart, keyEnd)
        continue
      }
      const role = table.roles[key]!
      const required = table.required[key]!
      if (table.marks[key] === object) {
        this.#repeat(table, row, keyStart, keyEnd)
        // A repeated key replaces the earlier value.
        if (required >= 0) table.present[required] = 0
        if (role <= GROUP) this.#clear(table, GROUP - role, row)
      }
      table.marks[key] = object
      // A group that is not an object is ignored.
      if (role <= GROUP && bytes[value] !== OPEN_OBJECT) continue
      if (required >= 0) table.present[required] = object
      if (role >= 0) stage(slots, role, value, end)
      else if (role === ID) {
        this.#id = value
        this.#idEnd = end
      } else if (role === LIST) {
        const mons = this.#mons[array]!
        mons[2 * record] = value
        mons[2 * record + 1] = end
      } else if (role <= GROUP) this.#group(table, GROUP - role, value, row)
      else if (role === OTHER) table.find(-1, bytes, keyStart, keyEnd).push(row, bytes, value, end)
    }
    table.lack(row, object)
    table.next(record)
    this.#identity(table, array, record)
    table.stage(slots)
  }

  /** Every table, including empty catalog tables, and the case's own row. */
  finish(): Parsed {
    const bytes = this.#bytes
    const tables = this.#shapes.map((shape, code) =>
      (this.#tables[code] ?? new TableBuilder(shape, bytes)).finish(),
    )
    const shape = this.#own
    const table = new TableBuilder(shape, bytes)
    const slots = this.#stage(table)
    const object = ++this.#objects
    for (const { name, value } of this.#layout.members) {
      const group = shape.groups.indexOf(name)
      // A group that is not an object, or an array member that is not an array, is ignored.
      if (group >= 0 && bytes[value] !== OPEN_OBJECT) continue
      if (ARRAYS.some((array) => array === name) && !this.#layout.arrays[name as ArrayName])
        continue
      const required = shape.required.indexOf(name)
      if (required >= 0) table.present[required] = object
      if (group >= 0) this.#group(table, group, value)
    }
    table.lack(0, object)
    table.next(0)
    table.ids.push(CASE_ROW)
    table.stage(slots)
    tables.push(table.finish())
    return { tables, mons: this.#mons, problems: this.#problems, repeats: this.#repeats }
  }

  /** A device record's table code from its class. The last `class` key wins, as in GridKit. */
  #classOf(count: number, record: number): number {
    const bytes = this.#bytes
    const spans = this.#members.spans
    for (let m = count - 1; m >= 0; m--) {
      if (CLASS_KEY.find(bytes, spans[4 * m]!, spans[4 * m + 1]!) !== 0) continue
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      if (bytes[value] !== QUOTE) {
        this.#problem(record, "A device's class is not text.")
        return NONE
      }
      const code = this.#classes.find(bytes, value + 1, end - 1)
      if (code >= DEVICE_CODES) return code
      const name = jsonText(bytes, value + 1, end - 1)
      // Bus, signal and case are types of their own, never device classes.
      if (code >= 0 || name === CASE) {
        this.#problem(record, `${name} is not a device class.`)
        return NONE
      }
      // An unknown class gets its own table, with its members discovered as they are read.
      let found = this.#unknown.get(name)
      if (found === undefined) {
        found = this.#shapes.push(unknownShape(name)) - 1
        this.#unknown.set(name, found)
      }
      return found
    }
    this.#problem(record, 'A device has no class.')
    return NONE
  }

  /** Stages a group's members into their slots, and with `row`, collects unknown members. */
  #group(table: TableBuilder, group: number, open: number, row?: number): void {
    const bytes = this.#bytes
    const { keys, slots, marks } = table.groups[group]!
    const count = this.#nested.read(bytes, open)
    const spans = this.#nested.spans
    const object = ++this.#objects
    for (let m = 0; m < count; m++) {
      const keyStart = spans[4 * m]!
      const keyEnd = spans[4 * m + 1]!
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      const known = keys.find(bytes, keyStart, keyEnd)
      if (known >= 0) {
        if (marks[known] === object) this.#repeat(table, row ?? 0, keyStart, keyEnd)
        marks[known] = object
        stage(this.#slots, slots[known]!, value, end)
      } else if (
        row !== undefined &&
        !table.find(group, bytes, keyStart, keyEnd).push(row, bytes, value, end)
      )
        this.#repeat(table, row, keyStart, keyEnd)
    }
  }

  /** Clears what `group` staged for `row` before a repeated group replaces it. */
  #clear(table: TableBuilder, group: number, row: number): void {
    for (const slot of table.groups[group]!.slots) stage(this.#slots, slot, -1, -1)
    table.forget(group, row)
  }

  #repeat(table: TableBuilder, row: number, start: number, end: number): void {
    this.#repeats.push({ type: table.shape.type, row, start: start - 1, end: end + 1 })
  }

  #stage(table: TableBuilder): Int32Array {
    const length = 2 * table.width
    if (this.#slots.length < length) this.#slots = new Int32Array(length)
    this.#slots.fill(-1, 0, length)
    this.#id = -1
    return this.#slots
  }

  #identity(table: TableBuilder, array: ArrayName, record: number): void {
    const { type, name } = table.shape.identity
    if (this.#id < 0) {
      this.#problem(record, `A ${table.shape.type} record has no ${name}.`, array)
      return table.ids.push(null)
    }
    if (type === 'text') {
      if (textInto(this.#bytes, table.ids as TextBuilder, this.#id, this.#idEnd)) return
      this.#problem(record, `A ${table.shape.type} record's id is not text.`, array)
      return table.ids.push(null)
    }
    const number = parseNumber(this.#bytes, this.#id, this.#idEnd)
    if (isId(number)) return (table.ids as NumericBuilder).pushNumber(number)
    this.#problem(
      record,
      `A ${table.shape.type} record's ${name} is not a whole number of 0 or more.`,
      array,
    )
    table.ids.push(null)
  }

  #problem(record: number, message: string, array: ArrayName = 'devices'): void {
    this.#problems.push({
      code: 'invalid-input',
      message,
      target: { kind: 'path', path: [array, record] },
    })
  }
}

/** Appends the value to `target` if it decodes as `type`, and returns whether it did. */
function decodeInto(
  bytes: Uint8Array,
  target: Builder,
  type: DecodeKind,
  value: number,
  end: number,
): boolean {
  if (type === 'number' || type === 'integer') {
    const number = parseNumber(bytes, value, end)
    // Any whole number is an integer, including `1.0` and `1e3`, as in GridKit.
    if (type === 'integer' ? !Number.isSafeInteger(number) : !Number.isFinite(number)) return false
    ;(target as NumericBuilder).pushNumber(number)
    return true
  }
  if (type === 'boolean') {
    const first = bytes[value]
    if (first !== TRUE_START && first !== FALSE_START) return false
    target.push(first === TRUE_START)
    return true
  }
  if (type === 'text') return textInto(bytes, target as TextBuilder, value, end)
  if (type !== 'path') return false
  const path: unknown = JSON.parse(text(bytes, value, end))
  if (
    !Array.isArray(path) ||
    !path.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every((lane) => typeof lane === 'number' && Number.isFinite(lane)),
    )
  )
    return false
  target.push(path)
  return true
}

function textInto(bytes: Uint8Array, target: TextBuilder, value: number, end: number): boolean {
  if (bytes[value] !== QUOTE) return false
  target.push(jsonText(bytes, value + 1, end - 1))
  return true
}

function stage(spans: Int32Array, at: number, value: number, end: number): void {
  spans[2 * at] = value
  spans[2 * at + 1] = end
}

/** Mantissa limits for exact parsing: the largest exact integer, and a tenth of it. */
const EXACT = Number.MAX_SAFE_INTEGER
const EXACT_TENTH = Math.floor(EXACT / 10)

/** Parses a JSON number with Clinger's fast path when the mantissa is exact and the exponent is
 *  within ±22, else with `Number()`. NaN when the bytes are not a JSON number. */
export function parseNumber(bytes: Uint8Array, start: number, end: number): number {
  let i = start
  const negative = bytes[i] === 0x2d
  if (negative) i++
  let mantissa = 0
  let exponent = 0
  let exact = true
  const first = i
  for (let c = bytes[i]!; i < end && c >= 0x30 && c <= 0x39; c = bytes[++i]!) {
    if (!exact) continue
    const next = mantissa * 10 + (c - 0x30)
    if (mantissa <= EXACT_TENTH && next <= EXACT) mantissa = next
    else exact = false
  }
  // Integer digits are required, without a leading zero.
  if (i === first || (bytes[first] === 0x30 && i > first + 1)) return NaN
  if (i < end && bytes[i] === 0x2e) {
    const fraction = ++i
    for (let c = bytes[i]!; i < end && c >= 0x30 && c <= 0x39; c = bytes[++i]!) {
      if (!exact) continue
      const next = mantissa * 10 + (c - 0x30)
      if (mantissa <= EXACT_TENTH && next <= EXACT) {
        mantissa = next
        exponent--
      } else exact = false
    }
    if (i === fraction) return NaN
  }
  if (i < end && (bytes[i] === 0x65 || bytes[i] === 0x45)) {
    i++
    const sign = bytes[i] === 0x2d ? -1 : 1
    if (bytes[i] === 0x2d || bytes[i] === 0x2b) i++
    const digits = i
    let power = 0
    for (let c = bytes[i]!; i < end && c >= 0x30 && c <= 0x39; c = bytes[++i]!)
      power = power * 10 + (c - 0x30)
    if (i === digits) return NaN
    exponent += sign * power
  }
  if (i !== end) return NaN
  if (exact && exponent >= -22 && exponent <= 22) {
    const value = exponent >= 0 ? mantissa * POW10[exponent]! : mantissa / POW10[-exponent]!
    return negative ? -value : value
  }
  return Number(text(bytes, start, end))
}
