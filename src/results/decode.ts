/** Decodes GridKit's CSV results a batch of frames at a time, never a whole run at once. */

import { addAbortSignal, type Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'

import { type Data, failure, type Index, type Query } from '@latkit/model'

import { type Case, outputName, type Table } from '../gridkit/index.js'
import { csvMessages } from './csv.js'
import { CHUNK_BYTES } from './limits.js'

/** One output a results file holds: a field of some rows of a table. */
export interface Field {
  readonly name: string
  /** The physical row numbering `rows` belong to. */
  readonly index: Index
  /** Ascending and distinct. */
  readonly rows: Uint32Array
  readonly axis: Index.Rows
}

/** Decoded frames, in arrays of their own that nothing writes again. */
interface Frames {
  readonly firstFrame: number
  readonly count: number
  readonly coordinates: Float64Array
  /** Per output decoded, in the order read, `count` frames of its rows, frame-major. */
  readonly values: readonly Float64Array[]
}

interface Reading {
  readonly signal: AbortSignal
  /** The frame the source starts at, which `publish` hears frames counted from. */
  readonly first?: number
  /** The outputs to decode, by their place among the file's; every one when absent. The rest are
   *  never read as numbers. */
  readonly only?: readonly number[]
  /** Keeps `frames` as they are: each batch is decoded into arrays of its own, and none crosses
   *  from one chunk into the next. */
  readonly publish: (frames: Frames) => void | Promise<void>
}

/** Where each output's rows are among the columns. */
interface Plan {
  /** Per output, the column of each of its rows. */
  readonly columns: readonly Int32Array[]
  /** Per output, the step between its rows' columns when they are evenly spaced; -1 when not. */
  readonly strides: Int32Array
}

/** How a results file reads, learned once from its header: its columns, what it holds, and the
 *  column each output's row reads. Every page reuses it, so a wide run's names are matched once. */
export interface Layout {
  /** The header's column names, which a page after the first is read with. */
  header?: readonly string[]
  /** What the header says the file holds, and where. */
  read?: { readonly fields: readonly Field[]; readonly plan: Plan }
}

/** Frames per chunk of a file holding `fields`: as many as CHUNK_BYTES of decoded frames hold. */
export function chunkFrames(fields: readonly Field[]): number {
  const frameBytes = 8 * (1 + fields.reduce((n, field) => n + field.rows.length, 0))
  return Math.max(1, Math.floor(CHUNK_BYTES / frameBytes))
}

/** One sample batch per output decoded, all over the same frames: of `only`, by their place among
 *  `fields`, else of every one. */
export function samplesOf(
  fields: readonly Field[],
  frames: Frames,
  only?: readonly number[],
): Data.SampleBatch[] {
  return (only ?? fields.map((_, f) => f)).map((f, i) => {
    const field = fields[f]!
    const values = frames.values[i]!
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
 *  what the file holds, so a run's file and one opened alone read alike. Once `layout` holds the
 *  header's names, `source` is rows alone; a header alone learns them. */
export async function readResults(
  source: Readable,
  kase: Case,
  reading: Reading,
  layout: Layout,
): Promise<void> {
  let plan: Plan | undefined
  let outputs: readonly Field[] = []
  /** The outputs decoded, by their place among the file's. */
  let decoding: readonly number[] = []
  let chunk = 1
  const first = reading.first ?? 0
  let received = 0
  let lastTime = -Infinity
  let yielded = performance.now()
  try {
    reading.signal.throwIfAborted()
    const chunks = addAbortSignal(reading.signal, source)
    // Rows read with a known header parse only the columns of the outputs asked for.
    const parse =
      reading.only && layout.header && layout.read
        ? columnsOf(layout.read.plan, reading.only, layout.header.length)
        : undefined
    for await (const message of csvMessages(chunks, layout.header, parse)) {
      reading.signal.throwIfAborted()
      if (message.kind === 'schema') {
        if (plan) throw failure('io', 'The results repeat their header.')
        layout.header ??= message.names
        layout.read ??= layoutOf(message.names, kase)
        plan = layout.read.plan
        outputs = layout.read.fields
        decoding = reading.only ?? outputs.map((_, f) => f)
        chunk = chunkFrames(outputs)
        continue
      }
      if (!plan) throw failure('io', 'The results hold rows before their header.')
      const { length, values: cells, width } = message
      if (!Number.isSafeInteger(received + length))
        throw failure('resource-limit', 'The results contain too many frames.')
      for (let from = 0, count = 0; from < length; from += count) {
        reading.signal.throwIfAborted()
        // Up to the next chunk's first frame.
        count = Math.min(length - from, chunk - ((first + received + from) % chunk))
        for (let t = from; t < from + count; t++) {
          const value = cells[t * width]!
          if (!Number.isFinite(value) || value < lastTime)
            throw failure('io', 'Result times must be finite and nondecreasing.')
          lastTime = value
        }
        // With no outputs to decode, only the times are checked.
        if (!decoding.length) continue
        // The copy kernel writes every cell, so fresh arrays need no clearing.
        const coordinates = new Float64Array(count)
        const values = decoding.map((f) => new Float64Array(count * outputs[f]!.rows.length))
        for (let t = 0; t < count; t++) coordinates[t] = cells[(from + t) * width]!
        copyRows(cells, width, plan, decoding, values, from, count)
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
    if (!plan) throw failure('io', 'The results contain no header.')
  } catch (error) {
    reading.signal.throwIfAborted()
    throw error
  }
}

/** The columns a read parses: the time, and each row of `outputs`. */
function columnsOf(plan: Plan, outputs: readonly number[], width: number): Uint8Array {
  const parse = new Uint8Array(width)
  parse[0] = 1
  for (const f of outputs) for (const column of plan.columns[f]!) parse[column] = 1
  return parse
}

/** Copies `outputs`' rows into `fields`, one array each in turn. */
function copyRows(
  source: Float64Array,
  width: number,
  plan: Plan,
  outputs: readonly number[],
  fields: readonly Float64Array[],
  from: number,
  count: number,
): void {
  for (let i = 0; i < outputs.length; i++) {
    const f = outputs[i]!
    const placed = plan.columns[f]!
    const values = fields[i]!
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
      const base = from * width + placed[row]!
      for (let t = 0; t < count; t++) values[t * rows + row] = source[base + t * width]!
    }
  }
}

/** A row's columns' common start: `<class>_<identity>_`. */
function stemOf(kase: Case, table: Table, row: number): string {
  const identity =
    table.shape.kind === 'bus' ? kase.cell(table, 'name', row) : kase.native(table, row)
  return `${table.shape.type}_${identity}_`
}

/** What a results file holds, from its header alone: each output of the case it has a column for,
 *  matched by complete name, case-insensitively, in catalog and row order, and the column each of
 *  their rows reads. A name that repeats matches its rows in turn. A column the case has no output
 *  for is left unread. */
function layoutOf(header: readonly string[], kase: Case): { fields: readonly Field[]; plan: Plan } {
  if (header.length === 0) throw failure('io', 'The results do not start with a time column.')
  const named = new Map<string, number[]>()
  header.forEach((name, column) => {
    if (column === 0) return
    const folded = fold(name)
    const columns = named.get(folded)
    if (columns) columns.push(column)
    else named.set(folded, [column])
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
      const held = Uint32Array.from(rows)
      fields.push({ name, index: table.index, rows: held, axis: axisOf(held) })
      columns.push(Int32Array.from(placed))
    }
  }
  if (!fields.length)
    throw failure('io', 'No result columns match this case. Open the case that wrote them.')
  const strides = Int32Array.from(columns, (placed) => {
    const first = placed[0]!
    const stride = placed.length > 1 ? placed[1]! - first : 0
    return stride >= 0 && placed.every((column, row) => column === first + row * stride)
      ? stride
      : -1
  })
  return { fields, plan: { columns, strides } }
}

/** `rows`, ascending, as the briefest axis: a range when they run unbroken, else their indices. */
export const axisOf = (rows: Uint32Array): Index.Rows =>
  rows.every((row, i) => row === rows[0]! + i)
    ? { kind: 'range', offset: rows[0] ?? 0, count: rows.length }
    : { kind: 'indices', values: rows }

/** What `fields` hold, as a selection of the rows of the case they were read against: a range when
 *  the rows run unbroken, as a whole type's do, else their indices. */
export function selectionsOf(fields: readonly Field[]): Query.Selection[] {
  return fields.map(({ index, name, axis }) => ({
    from: index.type,
    select: [name],
    rows: { ...axis, index },
  }))
}

/** A column name as names match: NFC-normalized, in lower case. */
function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}
