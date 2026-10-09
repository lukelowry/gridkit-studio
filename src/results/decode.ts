/** Decodes native results a batch of frames at a time, never a whole run at once. */

import { addAbortSignal, type Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'

import {
  failure,
  type FieldSelection,
  type Index,
  type RowAxis,
  type SampleBatch,
} from '@latkit/model'

import type { Case, Table } from '../gridkit/index.js'
import { type ArrowField, messages } from './arrow.js'
import { csvMessages } from './csv.js'
import { BATCH_BYTES } from './limits.js'

type ResultFormat = 'arrow' | 'csv'

/** One output a results file holds: a field of some rows of a table. */
export interface Field {
  readonly name: string
  /** The physical row numbering `rows` belong to. */
  readonly index: Index
  /** Ascending and distinct. */
  readonly rows: Uint32Array
  readonly axis: RowAxis
}

/** Decoded frames, in arrays of their own that nothing writes again. */
interface Frames {
  readonly firstFrame: number
  readonly count: number
  readonly coordinates: Float64Array
  /** Per output field, `count` frames of its rows, frame-major. */
  readonly values: readonly Float64Array[]
}

interface Reading {
  readonly signal: AbortSignal
  /** Keeps `frames` as they are: each batch is decoded into arrays of its own. */
  readonly publish: (frames: Frames) => void | Promise<void>
}

/** Where each output's rows are among the columns. */
interface Plan {
  /** Per column, 1 when it holds float64, 0 when float32. */
  readonly doubles: Uint8Array
  /** Per output, the column of each of its rows; -1 where none holds it. */
  readonly columns: readonly Int32Array[]
  /** Per output, the step between its rows' columns when they are evenly spaced; -1 when not. */
  readonly strides: Int32Array
}

/** How a results file reads, learned once from its header: its columns, what it holds, and the
 *  column each output's row reads. Every page reuses it, so a wide run's names are matched once. */
export interface Layout {
  /** The header's columns, which a CSV page after the first is read with. */
  header?: readonly ArrowField[]
  /** What the header says the file holds, and where. */
  read?: { readonly fields: readonly Field[]; readonly plan: Plan }
}

/** One sample batch per output field, all over the same frames. */
export function samplesOf(fields: readonly Field[], frames: Frames): SampleBatch[] {
  return fields.map((field, f) => {
    const values = frames.values[f]!
    return {
      kind: 'samples',
      index: field.index,
      rows: field.axis,
      firstFrame: frames.firstFrame,
      coordinates: frames.coordinates,
      columns: {
        [field.name]: {
          kind: 'numeric',
          values,
          offset: 0,
          length: values.length,
          frameStride: field.rows.length,
          rowStride: 1,
        },
      },
    }
  })
}

/** Reads the results in `source`, publishing each batch of frames as it decodes. The header says
 *  what the file holds, so a run's file and one opened alone read alike. Once `layout` holds a
 *  CSV header's columns, a CSV `source` is rows alone; a header alone learns them. */
export async function readResults(
  source: Readable,
  kase: Case,
  reading: Reading,
  format: ResultFormat,
  layout: Layout,
): Promise<void> {
  let plan: Plan | undefined
  let outputs: readonly Field[] = []
  let perBatch = 1
  let received = 0
  let lastTime = -Infinity
  let yielded = performance.now()
  try {
    reading.signal.throwIfAborted()
    const chunks = addAbortSignal(reading.signal, source)
    for await (const message of format === 'csv'
      ? csvMessages(chunks, layout.header)
      : messages(chunks)) {
      reading.signal.throwIfAborted()
      if (message.kind === 'schema') {
        if (plan) throw failure('io', 'The results repeat their schema.')
        layout.header ??= message.fields
        layout.read ??= layoutOf(message.fields, kase)
        plan = layout.read.plan
        outputs = layout.read.fields
        const frameBytes = 8 * (1 + outputs.reduce((n, field) => n + field.rows.length, 0))
        perBatch = Math.max(1, Math.floor(BATCH_BYTES / frameBytes))
        continue
      }
      if (!plan) throw failure('io', 'The results hold a batch before their schema.')
      const length = message.kind === 'rows' ? message.length : message.batch.length
      if (!Number.isSafeInteger(length) || length < 0)
        throw failure('io', 'Invalid result batch length.')
      if (!Number.isSafeInteger(received + length))
        throw failure('resource-limit', 'The results contain too many frames.')
      const decoded =
        message.kind === 'batch'
          ? arrowInput(message.body, message.batch.buffers, length, plan)
          : undefined
      for (let from = 0; from < length; from += perBatch) {
        reading.signal.throwIfAborted()
        const count = Math.min(perBatch, length - from)
        const time = decoded?.times
        for (let t = from; t < from + count; t++) {
          const value = message.kind === 'rows' ? message.values[t * message.width]! : time![t]!
          if (!Number.isFinite(value) || value < lastTime)
            throw failure('io', 'Result times must be finite and nondecreasing.')
          lastTime = value
        }
        // With no outputs, only the times are checked.
        if (!outputs.length) continue
        // The copy kernels write every cell, so fresh arrays need no clearing.
        const coordinates = new Float64Array(count)
        const values = outputs.map((field) => new Float64Array(count * field.rows.length))
        if (message.kind === 'rows') {
          for (let t = 0; t < count; t++)
            coordinates[t] = message.values[(from + t) * message.width]!
          copyRows(message.values, message.width, plan, values, from, count)
        } else {
          coordinates.set(time!.subarray(from, from + count))
          copyColumns(decoded!, values, from, count)
        }
        const published = reading.publish({
          firstFrame: received + from,
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
    if (!plan) throw failure('io', 'The results contain no schema.')
  } catch (error) {
    reading.signal.throwIfAborted()
    throw error
  }
}

interface ArrowInput {
  readonly body: Float64Array
  readonly decoded: Float64Array
  readonly starts: readonly Int32Array[]
  readonly times: Float64Array
  readonly frames: number
}

/** Plain native doubles stay in one body view; only float32/null columns need scratch decoding. */
function arrowInput(
  body: Uint8Array,
  buffers: Float64Array,
  frames: number,
  plan: Plan,
): ArrowInput {
  const doubles = new Float64Array(body.buffer, body.byteOffset, body.byteLength >>> 3)
  const regions = new Map<number, number>()
  const startOf = (column: number): number => {
    if (column >= 0) {
      const offset = buffers[4 * column + 2]!
      const bytes = buffers[4 * column + 3]!
      const bitOffset = buffers[4 * column]!
      const bitBytes = buffers[4 * column + 1]!
      const width = plan.doubles[column] === 1 ? 8 : 4
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset % 8 !== 0 ||
        !Number.isSafeInteger(bytes) ||
        bytes < width * frames ||
        offset + bytes > body.byteLength ||
        !Number.isSafeInteger(bitBytes) ||
        bitBytes < 0 ||
        (bitBytes > 0 &&
          (!Number.isSafeInteger(bitOffset) ||
            bitOffset < 0 ||
            bitBytes < Math.ceil(frames / 8) ||
            bitOffset + bitBytes > body.byteLength))
      )
        throw failure('io', 'The results hold a batch whose buffers are out of place.')
      if (width === 8 && bitBytes === 0) return offset / 8
    }
    let region = regions.get(column)
    if (region === undefined) regions.set(column, (region = regions.size))
    return -1 - region
  }
  const clock = startOf(0)
  const starts = plan.columns.map((columns) => Int32Array.from(columns, startOf))
  const decoded = new Float64Array(regions.size * frames)
  for (const [column, region] of regions) {
    const into = decoded.subarray(region * frames, (region + 1) * frames)
    if (column < 0) {
      into.fill(NaN)
      continue
    }
    const offset = body.byteOffset + buffers[4 * column + 2]!
    into.set(
      plan.doubles[column] === 1
        ? new Float64Array(body.buffer, offset, frames)
        : new Float32Array(body.buffer, offset, frames),
    )
    const bitBytes = buffers[4 * column + 1]!
    if (bitBytes) {
      const bitOffset = buffers[4 * column]!
      for (let t = 0; t < frames; t++)
        if ((body[bitOffset + (t >>> 3)]! & (1 << (t & 7))) === 0) into[t] = NaN
    }
  }
  return {
    body: doubles,
    decoded,
    starts,
    frames,
    times:
      clock >= 0
        ? doubles.subarray(clock, clock + frames)
        : decoded.subarray((-1 - clock) * frames, -clock * frames),
  }
}

function copyColumns(
  input: ArrowInput,
  fields: readonly Float64Array[],
  from: number,
  count: number,
): void {
  for (let f = 0; f < fields.length; f++) {
    const starts = input.starts[f]!
    const values = fields[f]!
    const rows = starts.length
    for (let row = 0; row < rows; row++) {
      const start = starts[row]!
      const cells = start >= 0 ? input.body : input.decoded
      const base = (start >= 0 ? start : (-1 - start) * input.frames) + from
      for (let t = 0; t < count; t++) values[t * rows + row] = cells[base + t]!
    }
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
      // Native channels are usually interleaved regularly; walk both buffers forwards.
      let into = 0
      for (let t = 0; t < count; t++) {
        let at = (from + t) * width + placed[0]!
        for (let row = 0; row < rows; row++, at += stride) values[into++] = source[at]!
      }
      continue
    }
    for (let row = 0; row < rows; row++) {
      const column = placed[row]!
      if (column < 0) {
        for (let t = 0; t < count; t++) values[t * rows + row] = NaN
      } else {
        const base = from * width + column
        for (let t = 0; t < count; t++) values[t * rows + row] = source[base + t * width]!
      }
    }
  }
}

/** The native column of a row's output `field`: `<class>_<identity>_<output>`, a bus by its name,
 *  the output by GridKit's name for it. */
export function columnName(kase: Case, table: Table, row: number, field: string): string {
  return stemOf(kase, table, row) + nativeOutput(table, field)
}

/** A row's columns' common start: `<class>_<identity>_`. */
function stemOf(kase: Case, table: Table, row: number): string {
  const identity =
    table.shape.kind === 'bus' ? kase.cell(table, 'name', row) : kase.native(table, row)
  return `${table.shape.type}_${identity}_`
}

/** GridKit's name for output `field`. */
function nativeOutput(table: Table, field: string): string {
  const source = table.shape.plan.get(field)?.source
  return source?.kind === 'output' ? source.name : field
}

/** What a results file holds, from its header alone: each output of the case it has a column for,
 *  matched by complete name, case-insensitively, in catalog and row order, and the column each of
 *  their rows reads. A name that repeats matches its rows in turn. A column the case has no output
 *  for is left unread. */
export function layoutOf(
  header: readonly ArrowField[],
  kase: Case,
): { fields: readonly Field[]; plan: Plan } {
  if (header.length === 0) throw failure('io', 'The results do not start with a time column.')
  const named = new Map<string, number[]>()
  header.forEach((field, column) => {
    if (column === 0) return
    const name = fold(field.name)
    const columns = named.get(name)
    if (columns) columns.push(column)
    else named.set(name, [column])
  })
  // A column is `<class>_<identity>_<output>`, so a class no column starts with is passed over.
  const classes = new Set([...named.keys()].map((name) => name.slice(0, name.indexOf('_'))))
  const fields: Field[] = []
  const columns: Int32Array[] = []
  for (const table of kase.tables.values()) {
    const type = fold(table.shape.type)
    if (!table.shape.outputOrder.size || !table.records.length) continue
    if (!type.includes('_') && !classes.has(type)) continue
    const stems = Array.from(table.records, (_, row) => fold(stemOf(kase, table, row)))
    for (const [name] of table.shape.outputOrder) {
      const output = fold(nativeOutput(table, name))
      const rows: number[] = []
      const placed: number[] = []
      for (let row = 0; row < stems.length; row++) {
        const column = named.get(stems[row]! + output)?.shift()
        if (column === undefined) continue
        rows.push(row)
        placed.push(column)
      }
      if (!rows.length) continue
      fields.push(outputOf(table.index, name, Uint32Array.from(rows)))
      columns.push(Int32Array.from(placed))
    }
  }
  if (!fields.length)
    throw failure('io', 'No result columns match this case. Open the case that wrote them.')
  const doubles = Uint8Array.from(header, (field) => (field.type === 'float64' ? 1 : 0))
  const strides = Int32Array.from(columns, (placed) => {
    const first = placed[0]!
    const stride = placed.length > 1 ? placed[1]! - first : 0
    return stride >= 0 && placed.every((column, row) => column === first + row * stride)
      ? stride
      : -1
  })
  return { fields, plan: { doubles, columns, strides } }
}

/** Output `name` of `rows` of the table `index` numbers. */
function outputOf(index: Index, name: string, rows: Uint32Array): Field {
  return {
    name,
    index,
    rows,
    axis: rows.every((row, i) => row === rows[0]! + i)
      ? { kind: 'range', offset: rows[0] ?? 0, count: rows.length }
      : { kind: 'indices', values: rows },
  }
}

/** What `fields` hold, as a selection of the case's rows by id. */
export function selectionsOf(kase: Case, fields: readonly Field[]): FieldSelection[] {
  return fields.map((field) => {
    const table = kase.table(field.index.type)
    return {
      from: field.index.type,
      select: [field.name],
      rows: { kind: 'ids', ids: Array.from(field.rows, (row) => kase.id(table, row)) },
    }
  })
}

/** A column name as names match: NFC-normalized, in lower case. */
export function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}
