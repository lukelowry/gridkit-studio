/** Numeric CSV with quoted UTF-8 headers. Consume each batch before its storage is reused. */

import { failure } from '@latkit/model'

import type { ArrowField } from './arrow.js'
import { BATCH_BYTES } from './limits.js'

export type CsvMessage =
  | { readonly kind: 'schema'; readonly fields: readonly ArrowField[] }
  | {
      readonly kind: 'rows'
      readonly length: number
      readonly values: Float64Array
      readonly width: number
    }

const HEADER_CHARS = 16 << 20
const CELL_CHARS = 1024

/** `known` is the header's columns, when an earlier read of the same results parsed it. */
export async function* csvMessages(
  source: AsyncIterable<Uint8Array>,
  batchRows = 64,
  known?: readonly ArrowField[],
): AsyncGenerator<CsvMessage> {
  if (!Number.isSafeInteger(batchRows) || batchRows < 1)
    throw new RangeError('CSV batch rows must be positive.')
  let header = ''
  let quoted = false
  let values: Float64Array | undefined
  let width = 0
  let capacity = 0
  let column = 0
  let rows = 0
  let received = 0
  let pending = ''

  for await (const text of textChunks(source)) {
    let start = 0
    if (values === undefined) {
      for (; start < text.length; start++) {
        const code = text.charCodeAt(start)
        if (code === 34) quoted = !quoted
        if (code === 10 && !quoted) break
      }
      if (!known) header += text.slice(0, start)
      if (header.length > HEADER_CHARS)
        throw failure('resource-limit', 'The CSV header exceeds 16,777,216 characters.')
      if (start === text.length) continue
      const fields =
        known ??
        headerOf(header).map((name, i) => ({ name, type: 'float64' as const, nullable: i !== 0 }))
      header = ''
      if (fields.length * 8 > BATCH_BYTES)
        throw failure('resource-limit', 'One CSV frame exceeds 8 MiB of numbers.')
      capacity = Math.min(batchRows, Math.floor(BATCH_BYTES / (8 * fields.length)))
      width = fields.length
      values = new Float64Array(fields.length * capacity)
      yield { kind: 'schema', fields }
      start++
    }

    // Cache the next newline: searching for it again for every comma is quadratic on wide cases.
    let newline = text.indexOf('\n', start)
    let comma = text.indexOf(',', start)
    while (start < text.length) {
      const end = comma < 0 ? newline : newline < 0 ? comma : Math.min(comma, newline)
      if (end < 0) {
        pending += text.slice(start)
        if (pending.length > CELL_CHARS)
          throw failure('io', 'A CSV number exceeds 1024 characters.')
        break
      }
      const token = pending + text.slice(start, end)
      pending = ''
      const last = end === newline
      start = end + 1
      if (last) newline = text.indexOf('\n', start)
      else comma = text.indexOf(',', start)
      if (last && column === 0 && token.trim() === '') continue
      if (token.length > CELL_CHARS || column >= width || (last && column !== width - 1))
        throw failure('io', `CSV frame ${received + rows + 1} does not match its header.`)
      const value = numberOf(token, received + rows + 1, column + 1)
      if (column === 0 && !Number.isFinite(value))
        throw failure('io', 'A CSV frame must have a finite time.')
      values[rows * width + column] = value
      column++
      if (!last) continue
      column = 0
      if (++rows === capacity) {
        yield { kind: 'rows', length: rows, values, width }
        received += rows
        rows = 0
      }
    }
  }
  if (values === undefined) throw failure('io', 'The CSV results do not have a complete header.')
  if (rows > 0) yield { kind: 'rows', length: rows, values, width }
}

/** A final newline terminates an otherwise complete last record; blank records are ignored. */
async function* textChunks(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for await (const part of source) {
    let text: string
    try {
      text = decoder.decode(part, { stream: true })
    } catch {
      throw failure('io', 'The CSV results are not valid UTF-8.')
    }
    yield text
  }
  try {
    yield decoder.decode() + '\n'
  } catch {
    throw failure('io', 'The CSV results end inside a UTF-8 character.')
  }
}

/** Quotes, doubled quotes, commas, and embedded newlines in names; never split an identity on underscores. */
function headerOf(text: string): string[] {
  if (text.endsWith('\r')) text = text.slice(0, -1)
  const names: string[] = []
  let start = 0
  while (start <= text.length) {
    let name = ''
    if (text[start] === '"') {
      let closed = false
      for (let i = start + 1; i < text.length; i++) {
        if (text[i] !== '"') {
          name += text[i]
          continue
        }
        if (text[i + 1] === '"') {
          name += '"'
          i++
          continue
        }
        start = i + 1
        closed = true
        break
      }
      if (!closed || (start < text.length && text[start] !== ','))
        throw failure('io', 'The CSV header has an invalid quoted name.')
    } else {
      const end = text.indexOf(',', start)
      const stop = end < 0 ? text.length : end
      name = text.slice(start, stop)
      if (name.includes('"'))
        throw failure('io', 'The CSV header has a quote inside an unquoted name.')
      start = stop
    }
    if (name.length === 0) throw failure('io', 'The CSV header has an empty column name.')
    names.push(name)
    if (start === text.length) break
    start++
  }
  if (!/^(t|time)$/i.test(names[0]!)) throw failure('io', 'The first CSV column must be t or time.')
  return names
}

function numberOf(text: string, frame: number, column: number): number {
  let token = text.trim()
  if (token[0] === '"' && token.at(-1) === '"') token = token.slice(1, -1).trim()
  if (token.length === 0) return NaN
  // Number accepts hexadecimal, octal, and binary literals; GridKit's CSV contains decimal numbers only.
  const prefix = token.charCodeAt(1) | 32
  if (!(token.charCodeAt(0) === 48 && (prefix === 120 || prefix === 111 || prefix === 98))) {
    const value = Number(token)
    if (!Number.isNaN(value)) return value
    if (/^[+-]?nan$/i.test(token)) return NaN
    if (/^[+-]?inf(?:inity)?$/i.test(token)) return token[0] === '-' ? -Infinity : Infinity
  }
  throw failure('io', `CSV frame ${frame}, column ${column} is not a number.`)
}
