import { text } from '../platform/bytes.js'
/** A case's JSON bytes: members and records indexed once, in file order, then columns decoded on
 *  demand. A member the catalog does not know, or a device class, is found and kept for its own
 *  column or table; invalid values become null. */
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
  isInt32,
  isUint32,
  NumericBuilder,
  type TextBuilder,
  utf8,
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
/** The first bytes of `null`, `true` and `false`. */
const NULL_START = 0x6e
const TRUE_START = 0x74
const FALSE_START = 0x66
const UTF8 = new TextEncoder()

export const ARRAYS: readonly ArrayName[] = ['buses', 'signals', 'devices']

export interface Member {
  readonly name: string
  /** The key's opening quote. */
  readonly start: number
  readonly value: number
  /** Just past the value. */
  readonly end: number
}

/** One array's brackets, and each record's start and end. */
export interface Records {
  readonly open: number
  readonly close: number
  readonly starts: Uint32Array
  readonly ends: Uint32Array
}

export interface Layout {
  readonly members: readonly Member[]
  readonly arrays: Readonly<Partial<Record<ArrayName, Records>>>
}

/** The case's members, and each array's records, found as the whole file is checked to be JSON
 *  with no object that repeats a key: what is read after takes the JSON as it is. Read a slice at a
 *  time, until `signal` lets go. */
export async function scan(bytes: Uint8Array, signal = AbortSignal.any([])): Promise<Layout> {
  const work = new Turns(signal)
  // A value's place is kept as a signed 32-bit number, where -1 says a record writes none.
  if (bytes.length > 0x7fffffff) throw problem('limit', 'A case file must be smaller than 2 GiB.')
  let i = skipSpace(bytes, 0)
  expect(bytes, i, OPEN_OBJECT, 'a case object')
  const members: Member[] = []
  const names = new Set<string>()
  const arrays: Partial<Record<ArrayName, Records>> = {}
  i = skipSpace(bytes, i + 1)
  while (bytes[i] !== CLOSE_OBJECT) {
    expect(bytes, i, QUOTE, 'a member name')
    const start = i
    const keyEnd = checkString(bytes, i)
    const name = keyOf(bytes, start, keyEnd)
    if (names.has(name)) malformed(start, 'a member name the case has not used')
    names.add(name)
    i = skipSpace(bytes, keyEnd)
    expect(bytes, i, COLON, 'a colon')
    const value = skipSpace(bytes, i + 1)
    let end: number
    if ((ARRAYS as readonly string[]).includes(name) && bytes[value] === OPEN_ARRAY) {
      const records = { open: value, ...(await recordsFrom(bytes, value + 1, work)) }
      arrays[name as ArrayName] = records
      end = records.close + 1
    } else end = checkValue(bytes, value)
    members.push({ name, start, value, end })
    i = skipSpace(bytes, end)
    if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
    else if (bytes[i] !== CLOSE_OBJECT) malformed(i, 'a comma or the end of the case')
  }
  if (skipSpace(bytes, i + 1) !== bytes.length) malformed(i + 1, 'the end of the file')
  return { members, arrays }
}

/** The records of an array of `bytes` from `from`, just past the array's opening bracket, each
 *  checked as JSON whole, and where the array closes. */
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
    expect(bytes, i, OPEN_OBJECT, 'a record')
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

/** Where each open object's keys are, and their hashes, as `checkValue` reads: a key is compared
 *  only with those of its own object that hash alike. Grown as needed, and kept between calls. */
let keyStarts: Int32Array = new Int32Array(256)
let keyEnds: Int32Array = new Int32Array(256)
let keyHashes: Int32Array = new Int32Array(256)

/** Just past the JSON value at `i`, checked as JSON whole: its grammar, without comments or trailing
 *  commas, and no object in it that repeats a key. A value nests as deep as it likes: the open
 *  objects and arrays are counted, never recursed into. */
function checkValue(bytes: Uint8Array, start: number): number {
  /** Per open container, 1 for an object, 0 for an array; where an object's keys begin; and, once
   *  it has many, its keys by hash. */
  const objects: number[] = []
  const firsts: number[] = []
  const indexes: (Map<number, number[]> | undefined)[] = []
  let keys = 0
  let i = start
  /** Reads the key at `i`, a repeat of none before it in its object; returns past its colon. */
  const key = (): number => {
    expect(bytes, i, QUOTE, 'a member name')
    const end = checkString(bytes, i)
    const hashed = hash(bytes, i, end) | 0
    const first = firsts.at(-1)!
    // A few keys are compared in turn; an object with many finds those that hash alike.
    let index = indexes.at(-1)
    if (!index && keys - first >= INDEXED_KEYS) {
      index = new Map()
      for (let k = first; k < keys; k++) indexed(index, keyHashes[k]!, k)
      indexes[indexes.length - 1] = index
    }
    if (index) {
      for (const k of index.get(hashed) ?? [])
        if (sameKey(bytes, keyStarts[k]!, keyEnds[k]!, i, end))
          malformed(i, 'a member name its object has not used')
      indexed(index, hashed, keys)
    } else
      for (let k = first; k < keys; k++)
        if (keyHashes[k] === hashed && sameKey(bytes, keyStarts[k]!, keyEnds[k]!, i, end))
          malformed(i, 'a member name its object has not used')
    if (keys === keyStarts.length) {
      keyStarts = grown(keyStarts)
      keyEnds = grown(keyEnds)
      keyHashes = grown(keyHashes)
    }
    keyStarts[keys] = i
    keyEnds[keys] = end
    keyHashes[keys++] = hashed
    const colon = skipSpace(bytes, end)
    expect(bytes, colon, COLON, 'a colon')
    return colon + 1
  }
  for (;;) {
    // A value at `i`.
    i = skipSpace(bytes, i)
    const first = bytes[i]
    if (first === OPEN_OBJECT || first === OPEN_ARRAY) {
      const object = first === OPEN_OBJECT
      i = skipSpace(bytes, i + 1)
      if (bytes[i] !== (object ? CLOSE_OBJECT : CLOSE_ARRAY)) {
        objects.push(object ? 1 : 0)
        firsts.push(keys)
        indexes.push(undefined)
        if (object) i = key()
        continue
      }
      i++
    } else if (first === QUOTE) i = checkString(bytes, i)
    else if (first === 0x74) i = checkWord(bytes, i, TRUE)
    else if (first === 0x66) i = checkWord(bytes, i, FALSE)
    else if (first === 0x6e) i = checkWord(bytes, i, NULL)
    else i = checkNumber(bytes, i)
    // Past a value: the next of its container's, or the container's end, and so on out.
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
      indexes.pop()
      keys = firsts.pop()!
    }
  }
}

/** How many keys an object has before its keys are found by hash rather than compared in turn. */
const INDEXED_KEYS = 128

/** Notes key `k`, which hashes as `hashed`, in `index`. */
function indexed(index: Map<number, number[]>, hashed: number, k: number): void {
  const alike = index.get(hashed)
  if (alike) alike.push(k)
  else index.set(hashed, [k])
}

const TRUE = UTF8.encode('true')
const FALSE = UTF8.encode('false')
const NULL = UTF8.encode('null')

/** Just past the literal `word` at `i`. */
function checkWord(bytes: Uint8Array, i: number, word: Uint8Array): number {
  for (let k = 0; k < word.length; k++) if (bytes[i + k] !== word[k]) malformed(i, 'a value')
  return i + word.length
}

/** Just past the JSON number at `i`: a sign, an integer part without leading zeros, and a fraction
 *  and an exponent, each with digits. */
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

/** Just past the JSON string whose opening quote is at `i`: no control character in it, and each
 *  escape one JSON has. */
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

/** `"`, `\`, `/`, `b`, `f`, `n`, `r` and `t`, as an escape names them. */
const ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74])

const isHex = (c: number | undefined) =>
  c !== undefined && ((c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x66))

/** Whether the keys at `[a, aEnd)` and `[b, bEnd)` name the same: their bytes, or, with escapes,
 *  the text they decode to. */
function sameKey(bytes: Uint8Array, a: number, aEnd: number, b: number, bEnd: number): boolean {
  if (aEnd - a === bEnd - b) {
    let same = true
    for (let k = 0; k < aEnd - a && same; k++) same = bytes[a + k] === bytes[b + k]
    if (same) return true
  }
  const escaped = (from: number, to: number) => bytes.subarray(from, to).includes(BACKSLASH)
  return (escaped(a, aEnd) || escaped(b, bEnd)) && keyOf(bytes, a, aEnd) === keyOf(bytes, b, bEnd)
}

/** Just past the JSON value at `i`, which `scan` has checked. */
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

/** Just past the string whose opening quote is at `i`. */
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

/** One object's members, four numbers each: its key's text inside the quotes, and its value. */
export class Members {
  spans = new Int32Array(256)

  /** Read the object at `open`; returns how many members it has. */
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

  /** Which of the `count` members last read is named `key`, as its key spells it, or -1. */
  find(bytes: Uint8Array, count: number, key: string): number {
    for (let m = 0; m < count; m++)
      if (jsonText(bytes, this.spans[4 * m]!, this.spans[4 * m + 1]!) === key) return m
    return -1
  }
}

/** A key's text, its quotes `start` and `end - 1`; escapes, which GridKit's keys never use, decoded
 *  the slow way. */
const keyOf = (bytes: Uint8Array, start: number, end: number): string =>
  jsonText(bytes, start + 1, end - 1)

/** The text of a JSON string whose text inside its quotes is `[start, end)`, escapes decoded. */
export function jsonText(bytes: Uint8Array, start: number, end: number): string {
  const raw = utf8(bytes, start, end)
  return raw.includes('\\') ? (JSON.parse('"' + raw + '"') as string) : raw
}

function expect(bytes: Uint8Array, i: number, code: number, what: string): void {
  if (bytes[i] !== code) malformed(i, what)
}

function malformed(at: number, what: string, more: object = {}): never {
  throw Object.assign(
    problem('invalid-input', `The case is not valid JSON: expected ${what} at byte ${at}.`),
    { byte: at, ...more },
  )
}

/** A chunk of a column as it was read: where each row's value is, decoded on its first read. */
export interface IndexedChunk {
  /** Whether any row writes a value other than `null`, read or not. */
  provided(): boolean
  read(): Chunk
  /** The rows, ascending, that write a value, not null, the column does not read as its type:
   *  told where the values are written, when that says, else found as it decodes. */
  wrong(): Uint32Array
}

/** The kinds of value a member the catalog does not know is written as; a `null` is none. */
export const TEXT = 1
export const BOOLEAN = 2
export const NUMBER = 4
const NESTED = 8

/** A member of a table's records that the catalog does not know, as a column of the table: the
 *  rows that write it, ascending, and each one's value as a start and an end. */
export interface FoundColumn {
  /** The keys to it, from a record's own. */
  readonly path: readonly string[]
  readonly rows: Uint32Array
  readonly spans: Int32Array
  /** TEXT, BOOLEAN, NUMBER and NESTED, each where a row writes such a value. */
  readonly kinds: number
}

/** What was read of one table's records. */
export interface ParsedTable {
  readonly shape: Shape
  readonly ids: readonly Chunk[]
  readonly fields: readonly (readonly IndexedChunk[])[]
  readonly ports: readonly (readonly IndexedChunk[])[]
  /** Each row's record in its array. */
  readonly records: Uint32Array
  /** The members its records write that the catalog does not know, as each is first written. */
  readonly found: readonly FoundColumn[]
  /** By each member the shape requires of a record, the rows whose records do not write it. */
  readonly lacking: readonly Uint32Array[]
}

/** What was read of a case. */
export interface Parsed {
  /** Its tables in order: the catalog's in its own, then each class it does not know as its first
   *  record comes, then the case's own. */
  readonly tables: readonly ParsedTable[]
  /** Each array's records' `mon` values, as a start and an end; 0, 0 where a record has none. */
  readonly mons: Readonly<Partial<Record<ArrayName, Uint32Array>>>
  /** The records refused, the first PROBLEMS of them. */
  readonly problems: readonly SourceProblem[]
}

const NONE = -1

const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i)
/** How many problems a read of a case says, at most: the first in the file. */
const PROBLEMS = 100

/** A fixed set of keys, matched against key bytes with no string made. */
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

  /** The index of the key whose text inside its quotes is `[start, end)`, or -1. A key written with
   *  escapes is the key they spell, as the check for repeated keys reads it. */
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

/** What a record's own member is, where it is no field of the record's own: the identity it is
 *  known by; its list of the outputs it records; a device's class, which names its table; one the
 *  shape knows only to require; or, from GROUP down, one of the groups its fields are under. */
const ID = -1
const LIST = -2
const TABLE = -3
const OTHER = -4
const GROUP = -5

/** A column of the rows whose values `spans` place in `bytes`, each a start and an end, -1 where
 *  a row has none: decoded on its first read, when it lets go of its spans and the file, and
 *  finds the rows that write what it cannot read. A port's value is the number of the row it
 *  names. */
function lazyColumn(
  bytes: Uint8Array,
  spans: Int32Array,
  type: DecodeKind,
  port: boolean,
): IndexedChunk {
  // Held apart, so the decoded column keeps nothing of the file alive.
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
        read = isUint32(number)
        if (read) (target as NumericBuilder).pushNumber(number)
      } else read = value >= 0 && into(bytes, target, type, value, end)
      if (read) continue
      target.push(null)
      // A value written, `null` aside, that does not read as the column's type.
      if (value >= 0 && bytes[value] !== NULL_START) wrong.push(row)
    }
    return { chunk: target.finish(), wrong: Uint32Array.from(wrong) }
  })
  /** The rows found wrong before the column decodes, where their first bytes say. */
  let told: Uint32Array | undefined
  return {
    // The same before it decodes and after.
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
      (told ??= unread && !port ? wrongOf(unread.bytes, unread.spans, type) : undefined) ??
      decode().wrong,
  }
}

/** The rows of a column of `type` that write a value, not null, it does not read, where a value's
 *  first bytes say so without reading it: JSON's syntax is checked by then, so a string, a boolean
 *  and a number each begin as nothing else does. A column nobody reads is checked so, and stays
 *  undecoded. Undefined for a type only reading a value says of. */
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

/** Whether the JSON number at [start, end) is one a double holds: any written without an exponent
 *  in fewer digits than the largest double has, and of the rest, those that read as finite. */
function finite(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start < 300) {
    let i = start
    while (i < end && bytes[i] !== 0x65 && bytes[i] !== 0x45) i++
    if (i === end) return true
  }
  return Number.isFinite(parseNumber(bytes, start, end))
}

/** Where a member found is looked for among a table's: by the hash of its key, the text inside
 *  its quotes at `[start, end)` of `key`, and of the group it is under. */
const placeOf = (key: Uint8Array, start: number, end: number, group: number): number =>
  hash(key, start, end) ^ Math.imul(group + 2, 0x9e3779b1)

/** A member the catalog does not know as its values are read: a FoundColumn as it grows. */
class Finding {
  #rows = new Uint32Array(16)
  #spans = new Int32Array(32)
  #count = 0
  #kinds = 0

  constructor(
    readonly path: readonly string[],
    /** Its key as it is spelled, and the group it is under: -1 for a record's own. */
    readonly key: Uint8Array,
    readonly group: number,
  ) {}

  /** Notes that `row` writes it as the value at `[value, end)`. */
  push(row: number, bytes: Uint8Array, value: number, end: number): void {
    if (this.#count === this.#rows.length) {
      this.#rows = grown(this.#rows)
      this.#spans = grown(this.#spans)
    }
    this.#rows[this.#count] = row
    this.#spans[2 * this.#count] = value
    this.#spans[2 * this.#count++ + 1] = end
    // JSON's syntax is checked by now, so a value's first byte says what it is.
    const first = bytes[value]!
    if (first === QUOTE) this.#kinds |= TEXT
    else if (first === TRUE_START || first === FALSE_START) this.#kinds |= BOOLEAN
    else if (first === 0x2d || (first >= 0x30 && first <= 0x39)) this.#kinds |= NUMBER
    else if (first !== NULL_START) this.#kinds |= NESTED
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

/** One table's rows as its records are read: their identities, and each field's and port's value
 *  as a span, cut into chunks of at most CHUNK_ROWS rows; the members they write that the catalog
 *  does not know; and the rows that write none of a member the shape requires. */
class Rows {
  /** A record's own members, what each is, and the bit of each one the shape requires. */
  readonly keys: Keys
  readonly what: Int32Array
  readonly bits: Int8Array
  /** The bits of every member the shape requires. */
  readonly all: number
  /** By group, the fields and ports under it, and the slot each one's value is staged in: a
   *  field's is its place among the shape's fields, a port's past them all. */
  readonly groups: readonly { readonly keys: Keys; readonly slots: Int32Array }[]
  /** How many values a row stages: one for each field, and one for each port. */
  readonly width: number
  ids!: Builder
  /** How many rows it has. */
  count = 0
  #spans!: Int32Array
  /** How many rows the chunk being filled has. */
  #staged = 0
  #records = new Uint32Array(256)
  readonly #lacking: number[][]
  readonly #found: Finding[] = []
  /** Where each member found is among them, by its key's hash: its place and one, 0 for none. */
  #places = new Int32Array(64)
  readonly #chunks: { ids: Chunk[]; fields: IndexedChunk[][]; ports: IndexedChunk[][] }

  constructor(
    readonly shape: Shape,
    readonly bytes: Uint8Array,
  ) {
    const { fields, ports, groups, required } = shape
    this.width = fields.length + ports.length
    const names: string[] = []
    const what: number[] = []
    const add = (name: string, is: number) => {
      names.push(name)
      what.push(is)
    }
    if (shape.array !== null) add(shape.identity.name, ID)
    // A bus and a device list what they record, and a device's class names its table.
    if (shape.kind === 'bus' || shape.kind === 'device') add(MON, LIST)
    if (shape.kind === 'device') add(CLASS, TABLE)
    fields.forEach((field, slot) => {
      if (field.path.length === 1) add(field.path[0]!, slot)
    })
    groups.forEach((group, place) => add(group, GROUP - place))
    for (const name of required) if (!names.includes(name)) add(name, OTHER)
    this.keys = new Keys(names)
    this.what = Int32Array.from(what)
    this.bits = Int8Array.from(names, (name) => required.indexOf(name))
    this.all = required.length === 0 ? 0 : -1 >>> (32 - required.length)
    this.groups = groups.map((group) => {
      const under: string[] = []
      const slots: number[] = []
      fields.forEach((field, slot) => {
        if (field.path.length !== 2 || field.path[0] !== group) return
        under.push(field.path[1]!)
        slots.push(slot)
      })
      ports.forEach((port, place) => {
        if (port.path[0] !== group) return
        under.push(port.path[1]!)
        slots.push(fields.length + place)
      })
      return { keys: new Keys(under), slots: Int32Array.from(slots) }
    })
    this.#lacking = required.map(() => [])
    this.#chunks = { ids: [], fields: fields.map(() => []), ports: ports.map(() => []) }
    this.#fresh()
  }

  /** Makes room for the row of record `record`, cutting a full chunk first. */
  next(record: number): void {
    if (this.#staged === CHUNK_ROWS) this.#flush()
    if (++this.#staged * 2 * this.width > this.#spans.length) this.#spans = grown(this.#spans)
    if (this.count === this.#records.length) this.#records = grown(this.#records)
    this.#records[this.count++] = record
  }

  /** Keeps where the row's values are, not the values. Its identity alone is read at once. */
  stage(slots: Int32Array): void {
    this.#spans.set(slots.subarray(0, 2 * this.width), (this.#staged - 1) * 2 * this.width)
  }

  /** Notes that the record of `row` writes none of the required members `missing` has a bit of. */
  lack(row: number, missing: number): void {
    for (let bit = 0; missing !== 0; bit++, missing >>>= 1)
      if (missing & 1) this.#lacking[bit]!.push(row)
  }

  /** The column of the member the catalog does not know whose key's text inside its quotes is
   *  `[start, end)`, under the group `group` or, with -1, a record's own: made as it is first
   *  found. A key written with escapes is the key they spell. */
  find(group: number, bytes: Uint8Array, start: number, end: number): Finding {
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
    let mask = this.#places.length - 1
    let slot = placeOf(key, start, end, group) & mask
    for (; this.#places[slot] !== 0; slot = (slot + 1) & mask) {
      const found = this.#found[this.#places[slot]! - 1]!
      if (found.group !== group || found.key.length !== end - start) continue
      let same = true
      for (let i = 0; i < found.key.length && same; i++) same = found.key[i] === key[start + i]
      if (same) return found
    }
    const name = spelled ?? utf8(bytes, start, end)
    const found = new Finding(
      group < 0 ? [name] : [this.shape.groups[group]!, name],
      // A copy, so the column keeps nothing of the file alive.
      Uint8Array.from(key.subarray(start, end)),
      group,
    )
    this.#places[slot] = this.#found.push(found)
    if (this.#found.length * 2 > this.#places.length) {
      // Each placed again, among twice as many places.
      this.#places = new Int32Array(this.#places.length * 2)
      mask = this.#places.length - 1
      this.#found.forEach((each, place) => {
        let at = placeOf(each.key, 0, each.key.length, each.group) & mask
        while (this.#places[at] !== 0) at = (at + 1) & mask
        this.#places[at] = place + 1
      })
    }
    return found
  }

  finish(): ParsedTable {
    this.#flush()
    return {
      shape: this.shape,
      ...this.#chunks,
      records: this.#records.slice(0, this.count),
      found: this.#found.map((found) => found.finish()),
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
    this.#fresh()
  }

  /** Each row's value of slot `slot`, as its start and end, of the rows staged. */
  #slot(slot: number): Int32Array {
    const spans = new Int32Array(2 * this.#staged)
    const width = 2 * this.width
    for (let row = 0, at = 2 * slot; row < this.#staged; row++, at += width) {
      spans[2 * row] = this.#spans[at]!
      spans[2 * row + 1] = this.#spans[at + 1]!
    }
    return spans
  }

  #fresh(): void {
    this.ids = builder(this.shape.identity.type)
    this.#spans = new Int32Array(256 * 2 * this.width)
    this.#staged = 0
  }
}

/** Reads a case's records into its tables, one record after another in file order. */
export class Parser {
  readonly #bytes: Uint8Array
  readonly #layout: Layout
  readonly #own: Shape
  readonly #classes: Keys
  /** Every table's shape by code: the catalog's, then each class it does not know, as found. */
  readonly #shapes: Shape[]
  readonly #unknown = new Map<string, number>()
  readonly #tables: (Rows | undefined)[] = []
  readonly #members = new Members()
  readonly #nested = new Members()
  /** The record being read: each field's and port's value as a start and end, -1 where absent. */
  #slots = new Int32Array(2 * 64)
  #id = -1
  #idEnd = -1
  readonly #mons: Partial<Record<ArrayName, Uint32Array>> = {}
  readonly #problems: SourceProblem[] = []

  /** A parser of the case `bytes` hold, which `layout` lays out, read with `catalog`. */
  constructor(catalog: Catalog, bytes: Uint8Array, layout: Layout) {
    this.#bytes = bytes
    this.#layout = layout
    this.#own = catalog.shapes.get(CASE)!
    this.#classes = new Keys(catalog.codes.map((shape) => shape.type))
    this.#shapes = [...catalog.codes]
    for (const array of ARRAYS) {
      const records = layout.arrays[array]
      if (records) this.#mons[array] = new Uint32Array(2 * records.starts.length)
    }
  }

  /** Reads record `record` of `array`. */
  record(array: ArrayName, record: number): void {
    const bytes = this.#bytes
    const count = this.#members.read(bytes, this.#layout.arrays[array]!.starts[record]!)
    const spans = this.#members.spans
    const code =
      array === 'buses'
        ? BUS_CODE
        : array === 'signals'
          ? SIGNAL_CODE
          : this.#classOf(count, record)
    if (code === NONE) return
    const rows = (this.#tables[code] ??= new Rows(this.#shapes[code]!, bytes))
    const slots = this.#stage(rows)
    const row = rows.count
    let seen = 0
    for (let m = 0; m < count; m++) {
      const keyStart = spans[4 * m]!
      const keyEnd = spans[4 * m + 1]!
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      const key = rows.keys.find(bytes, keyStart, keyEnd)
      const what = key < 0 ? OTHER : rows.what[key]!
      if (key >= 0 && rows.bits[key]! >= 0) seen |= 1 << rows.bits[key]!
      if (what >= 0) stage(slots, what, value, end)
      else if (what === ID) {
        this.#id = value
        this.#idEnd = end
      } else if (what === LIST) {
        const mons = this.#mons[array]!
        mons[2 * record] = value
        mons[2 * record + 1] = end
      } else if (what <= GROUP && bytes[value] === OPEN_OBJECT)
        this.#group(rows, GROUP - what, value, row)
      else if (what !== TABLE) rows.find(-1, bytes, keyStart, keyEnd).push(row, bytes, value, end)
    }
    if (seen !== rows.all) rows.lack(row, rows.all & ~seen)
    rows.next(record)
    this.#identity(rows, array, record)
    rows.stage(slots)
  }

  /** What it read: every table, each of the catalog's whether or not the case has a record of it,
   *  and the case's own row, read from the file's own members. */
  finish(): Parsed {
    const bytes = this.#bytes
    const tables = this.#shapes.map((shape, code) =>
      (this.#tables[code] ?? new Rows(shape, bytes)).finish(),
    )
    const shape = this.#own
    const rows = new Rows(shape, bytes)
    const slots = this.#stage(rows)
    const written = new Set<string>()
    for (const { name, value } of this.#layout.members) {
      written.add(name)
      const group = shape.groups.indexOf(name)
      // What else a header or the system's parameters hold is the file's own, and no field.
      if (group >= 0 && bytes[value] === OPEN_OBJECT) this.#group(rows, group, value)
    }
    shape.required.forEach((name, bit) => {
      if (!written.has(name)) rows.lack(0, 1 << bit)
    })
    rows.next(0)
    rows.ids.push(CASE_ROW)
    rows.stage(slots)
    tables.push(rows.finish())
    return { tables, mons: this.#mons, problems: this.#problems }
  }

  /** A device record's table code, from its class. */
  #classOf(count: number, record: number): number {
    const bytes = this.#bytes
    const spans = this.#members.spans
    for (let m = 0; m < count; m++) {
      if (CLASS_KEY.find(bytes, spans[4 * m]!, spans[4 * m + 1]!) !== 0) continue
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      if (bytes[value] !== QUOTE) break
      const code = this.#classes.find(bytes, value + 1, end - 1)
      if (code >= DEVICE_CODES) return code
      const name = jsonText(bytes, value + 1, end - 1)
      // A bus, a signal and the case are types of their own, never a device's class.
      if (code >= 0 || name === CASE) {
        this.#problem(record, `${name} is not a device class.`)
        return NONE
      }
      // A class the catalog does not know is a table of its own, its members found as they are.
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

  /** The members of the object at `open`, the group `group` of a record of `rows`: each staged to
   *  its field or port, or, for the record of `row`, found. */
  #group(rows: Rows, group: number, open: number, row?: number): void {
    const bytes = this.#bytes
    const { keys, slots } = rows.groups[group]!
    const count = this.#nested.read(bytes, open)
    const spans = this.#nested.spans
    for (let m = 0; m < count; m++) {
      const keyStart = spans[4 * m]!
      const keyEnd = spans[4 * m + 1]!
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      const known = keys.find(bytes, keyStart, keyEnd)
      if (known >= 0) stage(this.#slots, slots[known]!, value, end)
      else if (row !== undefined)
        rows.find(group, bytes, keyStart, keyEnd).push(row, bytes, value, end)
    }
  }

  /** Room for a row of `rows`, none of its values written yet. */
  #stage(rows: Rows): Int32Array {
    const length = 2 * rows.width
    if (this.#slots.length < length) this.#slots = new Int32Array(length)
    this.#slots.fill(-1, 0, length)
    this.#id = -1
    return this.#slots
  }

  #identity(rows: Rows, array: ArrayName, record: number): void {
    const { type, name } = rows.shape.identity
    if (this.#id < 0) {
      this.#problem(record, `A ${rows.shape.type} record has no ${name}.`, array)
      return rows.ids.push(null)
    }
    if (type === 'text') {
      if (textInto(this.#bytes, rows.ids as TextBuilder, this.#id, this.#idEnd)) return
      this.#problem(record, `A ${rows.shape.type} record's id is not text.`, array)
      return rows.ids.push(null)
    }
    const number = parseNumber(this.#bytes, this.#id, this.#idEnd)
    if (isUint32(number)) return (rows.ids as NumericBuilder).pushNumber(number)
    this.#problem(record, `A ${rows.shape.type} record's ${name} is not a whole number.`, array)
    rows.ids.push(null)
  }

  #problem(record: number, message: string, array: ArrayName = 'devices'): void {
    if (this.#problems.length < PROBLEMS)
      this.#problems.push({
        code: 'invalid-input',
        message,
        target: { kind: 'path', path: [array, record] },
      })
  }
}

/** The value at [value, end) into `target`, if it has the field's type. */
function into(
  bytes: Uint8Array,
  target: Builder,
  type: DecodeKind,
  value: number,
  end: number,
): boolean {
  if (type === 'number' || type === 'integer') {
    const number = parseNumber(bytes, value, end)
    if (!Number.isFinite(number)) return false
    // A whole number written as one: GridKit reads `1.0` as a real, which is no integer to it.
    if (type === 'integer' && !(isInt32(number) && whole(bytes, value, end))) return false
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
  const path: unknown = JSON.parse(utf8(bytes, value, end))
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

/** Whether the number at [start, end) is written without a fraction or an exponent. */
function whole(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = bytes[i]!
    if (c === 0x2e || c === 0x65 || c === 0x45) return false
  }
  return true
}

/** A JSON string's text into `target`. */
function textInto(bytes: Uint8Array, target: TextBuilder, value: number, end: number): boolean {
  if (bytes[value] !== QUOTE) return false
  target.push(jsonText(bytes, value + 1, end - 1))
  return true
}

function stage(spans: Int32Array, at: number, value: number, end: number): void {
  spans[2 * at] = value
  spans[2 * at + 1] = end
}

/** The most a number's digits make of it that a double still holds exactly, and the most they may
 *  be before the next digit could take them past it. */
const EXACT = Number.MAX_SAFE_INTEGER
const EXACT_TENTH = Math.floor(EXACT / 10)

/** A JSON number: exact by Clinger's fast path while its digits are a whole number a double holds
 *  and its exponent is small, else by the platform's parser; NaN when it is not a JSON number. */
export function parseNumber(bytes: Uint8Array, start: number, end: number): number {
  let i = start
  const negative = bytes[i] === 0x2d
  if (negative) i++
  let mantissa = 0
  let exponent = 0
  /** Whether every digit so far is in `mantissa`. */
  let exact = true
  const first = i
  for (let c = bytes[i]!; i < end && c >= 0x30 && c <= 0x39; c = bytes[++i]!) {
    if (!exact) continue
    const next = mantissa * 10 + (c - 0x30)
    if (mantissa <= EXACT_TENTH && next <= EXACT) mantissa = next
    else exact = false
  }
  // A whole part of digits, and no zero before another digit.
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
