/** Flat float32/float64 Arrow IPC: little-endian, uncompressed, no dictionaries. */

import { failure } from '@latkit/model'

export interface ArrowField {
  readonly name: string
  readonly nullable: boolean
  readonly type: 'float32' | 'float64'
}

interface BatchHeader {
  readonly length: number
  /** Per field, in pre-order, its length and null count. */
  readonly nodes: Float64Array
  /** Each buffer's offset and length in the body. */
  readonly buffers: Float64Array
}

/** A message as it arrives: a schema, or a batch and its 8-byte aligned body. */
type Message =
  | {
      readonly kind: 'schema'
      readonly fields: readonly ArrowField[]
      readonly metadata: ReadonlyMap<string, string>
    }
  | { readonly kind: 'batch'; readonly batch: BatchHeader; readonly body: Uint8Array }

type Header =
  | Extract<Message, { kind: 'schema' }>
  | { readonly kind: 'batch'; readonly batch: BatchHeader }
  | { readonly kind: 'other' }

const HEADER = { schema: 1, batch: 3 } as const
const FLOAT = 3
const CONTINUATION = 0xffffffff

/** A flatbuffer table: its fields by slot. */
class Table {
  constructor(
    readonly view: DataView,
    readonly at: number,
  ) {}

  #field(slot: number): number {
    const vtable = this.at - this.view.getInt32(this.at, true)
    const entry = 4 + 2 * slot
    const offset =
      entry < this.view.getUint16(vtable, true) ? this.view.getUint16(vtable + entry, true) : 0
    return offset === 0 ? 0 : this.at + offset
  }

  u8(slot: number): number {
    const at = this.#field(slot)
    return at ? this.view.getUint8(at) : 0
  }

  i16(slot: number): number {
    const at = this.#field(slot)
    return at ? this.view.getInt16(at, true) : 0
  }

  i64(slot: number): number {
    const at = this.#field(slot)
    return at ? int64(this.view, at) : 0
  }

  table(slot: number): Table | null {
    const at = this.#field(slot)
    return at ? new Table(this.view, at + this.view.getUint32(at, true)) : null
  }

  /** A vector's length and its first element's position. */
  vector(slot: number): { readonly length: number; readonly at: number } {
    const at = this.#field(slot)
    if (!at) return { length: 0, at: 0 }
    const target = at + this.view.getUint32(at, true)
    const length = this.view.getUint32(target, true)
    if (target + 4 + length > this.view.byteLength)
      throw failure('io', 'Arrow vector exceeds its metadata.')
    return { length, at: target + 4 }
  }

  tables(slot: number): Table[] {
    const { length, at } = this.vector(slot)
    if (at + 4 * length > this.view.byteLength)
      throw failure('io', 'Arrow table vector exceeds its metadata.')
    return Array.from(
      { length },
      (_, i) => new Table(this.view, at + 4 * i + this.view.getUint32(at + 4 * i, true)),
    )
  }

  string(slot: number): string {
    const { length, at } = this.vector(slot)
    return Buffer.from(this.view.buffer, this.view.byteOffset + at, length).toString('utf8')
  }
}

/** A 64-bit length or offset: far below 2^53, so read as two 32-bit halves, with no BigInt. */
function int64(view: DataView, at: number): number {
  return view.getUint32(at, true) + view.getInt32(at + 4, true) * 2 ** 32
}

/** The message whose flatbuffer is `metadata`, and its body's length. */
export function parseMessage(metadata: Uint8Array): {
  readonly header: Header
  readonly bodyLength: number
} {
  const view = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength)
  const root = new Table(view, view.getUint32(0, true))
  const type = root.u8(1)
  const header = root.table(2)
  const bodyLength = root.i64(3)
  if (header === null || (type !== HEADER.schema && type !== HEADER.batch))
    return { header: { kind: 'other' }, bodyLength }
  if (type === HEADER.schema) {
    if (header.i16(0) !== 0) throw failure('unsupported', 'Big-endian Arrow data is unsupported.')
    const metadata = new Map(
      header.tables(2).map((entry) => [entry.string(0), entry.string(1)] as const),
    )
    return {
      header: { kind: 'schema', fields: header.tables(1).map(readField), metadata },
      bodyLength,
    }
  }
  if (header.table(3) !== null)
    throw failure('unsupported', 'Compressed Arrow batches are unsupported.')
  const pairs = ({ length, at }: { length: number; at: number }): Float64Array => {
    if (at + 16 * length > view.byteLength)
      throw failure('io', 'Arrow buffer vector exceeds its metadata.')
    return Float64Array.from({ length: 2 * length }, (_, i) => int64(view, at + 8 * i))
  }
  return {
    header: {
      kind: 'batch',
      batch: {
        length: header.i64(0),
        nodes: pairs(header.vector(1)),
        buffers: pairs(header.vector(2)),
      },
    },
    bodyLength,
  }
}

function readField(field: Table): ArrowField {
  const code = field.u8(2)
  const type = field.table(3)
  if (field.table(4) !== null)
    throw failure('unsupported', 'Dictionary-encoded Arrow fields are unsupported.')
  const precision = type?.i16(0)
  if (code !== FLOAT || (precision !== 1 && precision !== 2))
    throw failure(
      'unsupported',
      `The results column ${field.string(0)} must be float32 or float64.`,
    )
  return {
    name: field.string(0),
    type: precision === 2 ? 'float64' : 'float32',
    nullable: field.u8(1) !== 0,
  }
}

/** The messages in `source`; each batch's body is reused for the next, so consume it first. */
export async function* messages(source: AsyncIterable<Uint8Array>): AsyncGenerator<Message> {
  const unread = new Unread()
  for await (const bytes of source) {
    unread.push(bytes)
    for (let next = unread.next(); next !== null; next = unread.next()) {
      if (next === 'end') return
      if (next !== 'skipped') yield next
    }
  }
  if (unread.length > 0) throw failure('io', 'The results end partway through a message.')
}

/** Bytes that arrived and are not read yet. */
class Unread {
  #pieces: Uint8Array[] = []
  #length = 0
  /** The message whose metadata is in: where its body starts, and how long it is. */
  #pending: { readonly header: Header; readonly start: number; readonly body: number } | null = null
  #metadata = new Uint8Array(0)
  #body = new Uint8Array(0)

  get length(): number {
    return this.#length
  }

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    this.#pieces.push(bytes)
    this.#length += bytes.length
  }

  /** The next message, 'skipped' for another kind, 'end' at the end, or null until more arrives. */
  next(): Message | 'skipped' | 'end' | null {
    if (this.#pending === null) {
      if (this.#length < 4) return null
      const first = this.#uint32(0)
      const prefix = first === CONTINUATION ? 8 : 4
      if (this.#length < prefix) return null
      const size = prefix === 8 ? this.#uint32(4) : first
      if (size === 0) {
        this.#drop(prefix)
        return 'end'
      }
      if (this.#length < prefix + size) return null
      this.#metadata = grown(this.#metadata, size)
      const metadata = this.#metadata.subarray(0, size)
      this.#copy(prefix, metadata)
      const { header, bodyLength } = parseMessage(metadata)
      if (!Number.isSafeInteger(bodyLength) || bodyLength < 0)
        throw failure('io', 'An Arrow message has an invalid body length.')
      this.#pending = { header, start: prefix + size, body: bodyLength }
    }
    const { header, start, body } = this.#pending
    if (this.#length < start + body) return null
    this.#pending = null
    if (header.kind !== 'batch') {
      this.#drop(start + body)
      return header.kind === 'schema' ? header : 'skipped'
    }
    this.#body = grown(this.#body, body)
    const bytes = this.#body.subarray(0, body)
    this.#copy(start, bytes)
    this.#drop(start + body)
    return { kind: 'batch', batch: header.batch, body: bytes }
  }

  #uint32(at: number): number {
    const bytes = new Uint8Array(4)
    this.#copy(at, bytes)
    return new DataView(bytes.buffer).getUint32(0, true)
  }

  /** Bytes from `at` on into `into`, as many as it holds. */
  #copy(at: number, into: Uint8Array): void {
    let skip = at
    let filled = 0
    for (const piece of this.#pieces) {
      if (filled >= into.length) return
      if (skip >= piece.length) {
        skip -= piece.length
        continue
      }
      const part = piece.subarray(skip, skip + into.length - filled)
      into.set(part, filled)
      filled += part.length
      skip = 0
    }
  }

  #drop(count: number): void {
    this.#length -= count
    let left = count
    let used = 0
    while (left > 0 && used < this.#pieces.length) {
      const piece = this.#pieces[used]!
      if (piece.length <= left) {
        left -= piece.length
        used++
      } else {
        this.#pieces[used] = piece.subarray(left)
        left = 0
      }
    }
    this.#pieces = this.#pieces.slice(used)
  }
}

function grown(buffer: Uint8Array<ArrayBuffer>, size: number): Uint8Array<ArrayBuffer> {
  return buffer.length >= size ? buffer : new Uint8Array(Math.max(size, 2 * buffer.length))
}
