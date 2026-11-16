/** Decodes GridKit's CSV results one batch of frames at a time, never a whole run at once. */

import type { Id } from 'latkit'

import { type Case, outputName, type Table } from '../gridkit/index.js'
import { setImmediate } from '../platform/timing.js'
import type { RecordedField } from '../shared/data.js'
import { problem } from '../shared/errors.js'
import { csvMessages, type LongReading } from './csv.js'
import { CHUNK_BYTES } from './limits.js'

export interface Field {
  readonly table: string
  readonly field: string
  readonly ids: readonly Id[]
}

/** Decoded frames, in fresh arrays that nothing writes again. */
export interface Decoded {
  readonly firstFrame: number
  readonly count: number
  readonly coordinates: Float64Array
  /** Per output, `count` frames of its rows, frame-major. */
  readonly values: readonly Float64Array[]
}

interface Reading {
  readonly signal: AbortSignal
  readonly first?: number
  /** Receives each batch. No batch crosses a chunk boundary. */
  readonly publish: (frames: Decoded) => void | Promise<void>
  /** Whether the source ends the file, which completes a long layout's only sample. */
  readonly final?: boolean
}

interface Plan {
  readonly columns: readonly Int32Array[]
  /** Per output, the step between its rows' columns when evenly spaced, else -1. */
  readonly strides: Int32Array
}

/** Learned once from the header and reused by every page, so a wide run's names match once. */
export interface Layout {
  header?: readonly string[]
  read?: { readonly fields: readonly Field[]; readonly plan: Plan }
  /** Long-layout state. The first sample provides the header. */
  long?: LongReading
}

function chunkFrames(fields: readonly Field[]): number {
  const frameBytes = 8 * (1 + fields.reduce((n, field) => n + field.ids.length, 0))
  return Math.max(1, Math.floor(CHUNK_BYTES / frameBytes))
}

/** Publishes each batch of frames as it decodes. Once `layout` has the header, `source` has rows
 *  only. */
export async function readResults(
  source: AsyncIterable<Uint8Array>,
  kase: Case,
  reading: Reading,
  layout: Layout,
): Promise<void> {
  let plan: Plan | undefined
  let outputs: readonly Field[] = []
  let chunk = 1
  const first = reading.first ?? 0
  let received = 0
  let lastTime = -Infinity
  let yielded = performance.now()
  try {
    reading.signal.throwIfAborted()
    const chunks = source
    for await (const message of csvMessages(chunks, layout.header, first, layout, reading.final)) {
      reading.signal.throwIfAborted()
      if (message.kind === 'schema') {
        if (plan) throw problem('io', 'The results repeat their header.')
        layout.header ??= message.names
        layout.read ??= layoutOf(message.names, kase)
        plan = layout.read.plan
        outputs = layout.read.fields
        chunk = chunkFrames(outputs)
        continue
      }
      if (!plan) throw problem('io', 'The results hold rows before their header.')
      const { length, values: cells, width } = message
      for (let from = 0, count = 0; from < length; from += count) {
        reading.signal.throwIfAborted()
        count = Math.min(length - from, chunk - ((first + received + from) % chunk))
        for (let t = from; t < from + count; t++) {
          const value = cells[t * width]!
          if (!Number.isFinite(value) || value < lastTime)
            throw problem('io', 'Result times must be finite and nondecreasing.')
          lastTime = value
        }
        // The copy kernel writes every cell, so fresh arrays need no clearing.
        const coordinates = new Float64Array(count)
        const values = outputs.map((field) => new Float64Array(count * field.ids.length))
        for (let t = 0; t < count; t++) coordinates[t] = cells[(from + t) * width]!
        copyRows(cells, width, plan, values, from, count)
        const published = reading.publish({
          firstFrame: first + received + from,
          count,
          coordinates,
          values,
        })
        if (published !== undefined) await published
      }
      received += length
      // Give sockets and cancellation a turn without scheduling every tiny result batch.
      if (performance.now() - yielded >= 4) {
        await setImmediate(undefined, { signal: reading.signal })
        yielded = performance.now()
      }
    }
  } catch (error) {
    reading.signal.throwIfAborted()
    throw error
  }
}

function copyRows(
  source: Float64Array,
  width: number,
  plan: Plan,
  fields: readonly Float64Array[],
  from: number,
  count: number,
): void {
  for (let f = 0; f < fields.length; f++) {
    const placed = plan.columns[f]!
    const values = fields[f]!
    const rows = placed.length
    const stride = plan.strides[f]!
    if (stride >= 0) {
      // Evenly spaced columns are common, so walk both buffers forward.
      let into = 0
      for (let t = 0; t < count; t++) {
        let at = (from + t) * width + placed[0]!
        for (let row = 0; row < rows; row++, at += stride) values[into++] = source[at]!
      }
      continue
    }
    for (let row = 0; row < rows; row++) {
      const base = from * width + placed[row]!
      for (let t = 0; t < count; t++) values[t * rows + row] = source[base + t * width]!
    }
  }
}

/** `<class>_<identity>_`. */
function stemOf(kase: Case, table: Table, row: number): string {
  const identity =
    table.shape.kind === 'bus' ? kase.cell(table, 'name', row) : kase.native(table, row)
  return `${table.shape.type}_${identity}_`
}

export const layoutFrom = (names: readonly string[], kase: Case): Layout => ({
  header: names,
  read: layoutOf(names, kase),
})

/** The case's outputs with columns in `header`, matched by full name case-insensitively. A repeated
 *  name matches successive rows. */
function layoutOf(header: readonly string[], kase: Case): { fields: readonly Field[]; plan: Plan } {
  const named = new Map<string, number[]>()
  header.forEach((name, column) => {
    if (column === 0) return
    const folded = fold(name)
    const columns = named.get(folded)
    if (columns) columns.push(column)
    else named.set(folded, [column])
  })
  // Columns are `<class>_<identity>_<output>`, so skip classes that no column starts with.
  const classes = new Set([...named.keys()].map((name) => name.slice(0, name.indexOf('_'))))
  const fields: Field[] = []
  const columns: Int32Array[] = []
  for (const table of kase.tables.values()) {
    const type = fold(table.shape.type)
    if (!table.shape.outputs.length || !table.records.length) continue
    if (!type.includes('_') && !classes.has(type)) continue
    const stems = Array.from(table.records, (_, row) => fold(stemOf(kase, table, row)))
    for (const name of table.shape.outputs) {
      const output = fold(outputName(table, name))
      const rows: number[] = []
      const placed: number[] = []
      for (let row = 0; row < stems.length; row++) {
        const column = named.get(stems[row]! + output)?.shift()
        if (column === undefined) continue
        rows.push(row)
        placed.push(column)
      }
      if (!rows.length) continue
      fields.push({
        field: name,
        table: table.shape.type,
        ids: rows.map((row) => kase.native(table, row)),
      })
      columns.push(Int32Array.from(placed))
    }
  }
  if (!fields.length)
    throw problem('io', 'No result columns match this case. Open the case that wrote them.')
  const strides = Int32Array.from(columns, (placed) => {
    const first = placed[0]!
    const stride = placed.length > 1 ? placed[1]! - first : 0
    return stride >= 0 && placed.every((column, row) => column === first + row * stride)
      ? stride
      : -1
  })
  return { fields, plan: { columns, strides } }
}

export function recordedFields(fields: readonly Field[]): RecordedField[] {
  return fields.map((field) => ({ ...field, ids: [...field.ids] }))
}

function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}
