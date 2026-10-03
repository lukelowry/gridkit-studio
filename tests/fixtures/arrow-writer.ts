/** Fixture writer; production only decodes Arrow. */
import type { ArrowField } from '../../src/results/arrow.js'
export type { ArrowField }
export interface ArrowColumn {
  readonly values: Float32Array | Float64Array
  readonly validity?: Uint8Array
}
const V5 = 4
const HEADER = { schema: 1, batch: 3 } as const
const FLOAT = 3
const CONTINUATION = 0xffffffff
export const EOS = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0])
export function fieldOf(name: string, type: ArrowField['type'], nullable: boolean): ArrowField {
  return { name, type, nullable }
}

type Scalar = { readonly bytes: 1 | 2 | 8; readonly value: number }
type Node =
  | { readonly kind: 'table'; readonly fields: readonly (Scalar | Node | undefined)[] }
  | { readonly kind: 'string'; readonly bytes: Uint8Array }
  | { readonly kind: 'tables'; readonly items: readonly Node[] }
  | { readonly kind: 'structs'; readonly count: number; readonly bytes: Uint8Array }

const table = (...fields: (Scalar | Node | undefined)[]): Node => ({ kind: 'table', fields })
const u8 = (value: number): Scalar => ({ bytes: 1, value })
const i16 = (value: number): Scalar => ({ bytes: 2, value })
const i64 = (value: number): Scalar => ({ bytes: 8, value })
const text = (value: string): Node => ({ kind: 'string', bytes: Buffer.from(value, 'utf8') })

/** A flatbuffer laid out front to back, each object after whatever refers to it so every offset is forward, and
 *  each table's vtable just before it. Objects are laid out in the order reached, off a queue that only grows, so
 *  a schema of many fields lays out in time linear in them. */
function flatbuffer(root: Node): Uint8Array {
  let bytes = new Uint8Array(1024)
  let view = new DataView(bytes.buffer)
  let size = 4
  const reserve = (count: number): number => {
    if (size + count > bytes.length) {
      const next = new Uint8Array(Math.max(bytes.length * 2, size + count))
      next.set(bytes)
      bytes = next
      view = new DataView(bytes.buffer)
    }
    const at = size
    size += count
    return at
  }
  const align = (to: number, after = 0): void => {
    while ((size + after) % to !== 0) reserve(1)
  }
  const pending: { readonly from: number; readonly node: Node }[] = [{ from: 0, node: root }]
  for (let next = 0; next < pending.length; next++) {
    const { from, node } = pending[next]!
    let at: number
    if (node.kind === 'table') {
      // The vtable offset, then fields widest first, each aligned to its width.
      const width = (field: Scalar | Node | undefined): number =>
        field && 'value' in field ? field.bytes : 4
      const slots = node.fields
        .map((field, slot) => ({ field, slot }))
        .filter(({ field }) => field !== undefined)
        .sort((a, b) => width(b.field) - width(a.field))
      const offsets = new Map<number, number>()
      let inline = 4
      for (const { field, slot } of slots) {
        inline = Math.ceil(inline / width(field)) * width(field)
        offsets.set(slot, inline)
        inline += width(field)
      }
      align(2)
      const vtable = reserve(4 + 2 * node.fields.length)
      view.setUint16(vtable, 4 + 2 * node.fields.length, true)
      view.setUint16(vtable + 2, inline, true)
      node.fields.forEach((_, slot) =>
        view.setUint16(vtable + 4 + 2 * slot, offsets.get(slot) ?? 0, true),
      )
      align(8)
      at = reserve(Math.ceil(inline / 8) * 8)
      view.setInt32(at, at - vtable, true)
      for (const { field, slot } of slots) {
        const place = at + offsets.get(slot)!
        if (field === undefined) continue
        if (!('value' in field)) pending.push({ from: place, node: field })
        else if (field.bytes === 1) view.setUint8(place, field.value)
        else if (field.bytes === 2) view.setInt16(place, field.value, true)
        else setInt64(view, place, field.value)
      }
    } else if (node.kind === 'string') {
      align(4)
      at = reserve(4 + node.bytes.length + 1)
      view.setUint32(at, node.bytes.length, true)
      bytes.set(node.bytes, at + 4)
    } else if (node.kind === 'tables') {
      align(4)
      at = reserve(4 + 4 * node.items.length)
      view.setUint32(at, node.items.length, true)
      node.items.forEach((item, i) => pending.push({ from: at + 4 + 4 * i, node: item }))
    } else {
      align(8, 4)
      at = reserve(4 + node.bytes.length)
      view.setUint32(at, node.count, true)
      bytes.set(node.bytes, at + 4)
    }
    view.setUint32(from, at - from, true)
  }
  return bytes.slice(0, size)
}

function setInt64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value % 2 ** 32, true)
  view.setUint32(at + 4, Math.floor(value / 2 ** 32), true)
}

function fieldNode(field: ArrowField): Node {
  return table(
    text(field.name),
    u8(field.nullable ? 1 : 0),
    u8(FLOAT),
    table(i16(field.type === 'float64' ? 2 : 1)),
  )
}

/** One message in one buffer: the continuation marker, the padded metadata's length, the metadata, then
 *  `bodyLength` zeroed bytes of 8-byte aligned body for the caller to fill. */
function framed(metadata: Uint8Array, bodyLength: number): Uint8Array {
  const padded = Math.ceil((metadata.length + 8) / 8) * 8 - 8
  const message = new Uint8Array(8 + padded + bodyLength)
  const view = new DataView(message.buffer)
  view.setUint32(0, CONTINUATION, true)
  view.setInt32(4, padded, true)
  message.set(metadata, 8)
  return message
}

export function schemaMessage(
  fields: readonly ArrowField[],
  metadata: ReadonlyMap<string, string> = new Map(),
): Uint8Array {
  const entries: Node = {
    kind: 'tables',
    items: [...metadata].map(([key, value]) => table(text(key), text(value))),
  }
  const schema = table(i16(0), { kind: 'tables', items: fields.map(fieldNode) }, entries)
  return framed(flatbuffer(table(i16(V5), u8(HEADER.schema), schema, i64(0))), 0)
}

/** A batch of `columns`, one per schema field, as one message: each buffer copied once into
 *  its aligned place in the body. */
export function batchMessage(length: number, columns: readonly ArrowColumn[]): Uint8Array {
  const nodes: number[] = []
  const buffers: Uint8Array[] = []
  const add = (view: ArrayBufferView | undefined, bytes?: number): void =>
    void buffers.push(
      view === undefined
        ? new Uint8Array(0)
        : new Uint8Array(view.buffer, view.byteOffset, bytes ?? view.byteLength),
    )
  for (const column of columns) {
    nodes.push(length, nullsOf(column, length))
    add(column.validity, Math.ceil(length / 8))
    add(column.values, length * column.values.BYTES_PER_ELEMENT)
  }
  const places: number[] = []
  let bodyLength = 0
  for (const buffer of buffers) {
    places.push(bodyLength, buffer.length)
    bodyLength += Math.ceil(buffer.length / 8) * 8
  }
  const header = table(
    i64(length),
    { kind: 'structs', count: nodes.length / 2, bytes: int64s(nodes) },
    { kind: 'structs', count: buffers.length, bytes: int64s(places) },
  )
  const message = framed(
    flatbuffer(table(i16(V5), u8(HEADER.batch), header, i64(bodyLength))),
    bodyLength,
  )
  const body = message.length - bodyLength
  buffers.forEach((buffer, i) => message.set(buffer, body + places[2 * i]!))
  return message
}

function int64s(numbers: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(8 * numbers.length)
  const view = new DataView(bytes.buffer)
  numbers.forEach((value, i) => setInt64(view, 8 * i, value))
  return bytes
}

function nullsOf(column: ArrowColumn, length: number): number {
  if (column.validity === undefined) return 0
  let nulls = 0
  for (let i = 0; i < length; i++) if ((column.validity[i >>> 3]! & (1 << (i & 7))) === 0) nulls++
  return nulls
}
