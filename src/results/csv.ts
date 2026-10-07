/** GridKit's numeric CSV results, under a header of quoted UTF-8 names. */

import { failure } from '@latkit/model'

import type { ArrowField } from './arrow.js'
import { BATCH_BYTES } from './limits.js'

type CsvMessage =
  | { readonly kind: 'schema'; readonly fields: readonly ArrowField[] }
  | {
      readonly kind: 'rows'
      readonly length: number
      /** `length` rows of `width` numbers, row-major. */
      readonly values: Float64Array
      readonly width: number
    }

/** The header, then batches of rows whose values are reused, so consume each before advancing.
 *  `known` is the header's columns, when another read of the same results parsed it: `source` is
 *  then rows alone. */
export async function* csvMessages(
  source: AsyncIterable<Uint8Array>,
  known?: readonly ArrowField[],
): AsyncGenerator<CsvMessage> {
  let header = ''
  let quoted = false
  let headed = false
  let values = new Float64Array(0)
  let width = 0
  let capacity = 0
  let column = 0
  let rows = 0
  let received = 0
  let pending = ''
  const schema = (fields: readonly ArrowField[]): CsvMessage => {
    headed = true
    width = fields.length
    capacity = Math.max(1, Math.floor(BATCH_BYTES / (8 * width)))
    return { kind: 'schema', fields }
  }
  if (known) yield schema(known)

  for await (const text of textChunks(source)) {
    let start = 0
    if (!headed) {
      for (; start < text.length; start++) {
        const code = text.charCodeAt(start)
        if (code === 34) quoted = !quoted
        if (code === 10 && !quoted) break
      }
      header += text.slice(0, start)
      if (start === text.length) continue
      yield schema(
        headerOf(header).map((name, i) => ({ name, type: 'float64' as const, nullable: i !== 0 })),
      )
      header = ''
      start++
    }

    // Keep the next newline: searching again for every comma is quadratic in a wide case.
    let newline = text.indexOf('\n', start)
    let comma = text.indexOf(',', start)
    while (start < text.length) {
      const end = comma < 0 ? newline : newline < 0 ? comma : Math.min(comma, newline)
      if (end < 0) {
        pending += text.slice(start)
        break
      }
      const token = pending + text.slice(start, end)
      pending = ''
      const last = end === newline
      start = end + 1
      if (last) newline = text.indexOf('\n', start)
      else comma = text.indexOf(',', start)
      if (last && column === 0 && token.trim() === '') continue
      if (column >= width || (last && column !== width - 1))
        throw failure('io', `CSV frame ${received + rows + 1} does not match its header.`)
      const value = numberOf(token, received + rows + 1, column + 1)
      if (column === 0) {
        if (!Number.isFinite(value)) throw failure('io', 'A CSV frame must have a finite time.')
        // A batch's buffer grows as its rows arrive, so a page of a few rows allocates little.
        if (rows * width === values.length) {
          const more = new Float64Array(width * Math.min(capacity, Math.max(64, 2 * rows)))
          more.set(values)
          values = more
        }
      }
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
  if (!headed) throw failure('io', 'The CSV results do not have a complete header.')
  if (rows > 0) yield { kind: 'rows', length: rows, values, width }
}

/** The time of each row in `bytes`, rows whose header was read before: each row's first number,
 *  read as `csvMessages` reads it, and nothing after it. */
export function csvTimes(bytes: Uint8Array): Float64Array {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw failure('io', 'The CSV results are not valid UTF-8.')
  }
  const times: number[] = []
  // Keep the next comma: a row with none must not search the rest of the page again.
  let comma = -1
  for (let start = 0; start < text.length;) {
    let newline = text.indexOf('\n', start)
    if (newline < 0) newline = text.length
    if (comma < start) {
      comma = text.indexOf(',', start)
      if (comma < 0) comma = text.length
    }
    const token = text.slice(start, Math.min(comma, newline))
    start = newline + 1
    if (comma >= newline && token.trim() === '') continue
    const time = numberOf(token, times.length + 1, 1)
    if (!Number.isFinite(time)) throw failure('io', 'A CSV frame must have a finite time.')
    times.push(time)
  }
  return Float64Array.from(times)
}

/** `source` as text, with a newline after it to end a last record that has none. Each part is
 *  decoded whole, several times faster than streaming, once the bytes of a character it ends
 *  partway through are carried to the next. */
async function* textChunks(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let carried: Uint8Array = new Uint8Array(0)
  for await (const part of source) {
    const bytes = carried.length ? Buffer.concat([carried, part]) : part
    const end = bytes.length - unfinished(bytes)
    carried = bytes.slice(end)
    let text: string
    try {
      text = decoder.decode(bytes.subarray(0, end))
    } catch {
      throw failure('io', 'The CSV results are not valid UTF-8.')
    }
    yield text
  }
  if (carried.length) throw failure('io', 'The CSV results end inside a UTF-8 character.')
  yield '\n'
}

/** How many of the last of `bytes` begin a UTF-8 character that they do not finish. */
function unfinished(bytes: Uint8Array): number {
  // A character is at most four bytes, so an unfinished one leads among the last three.
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back]!
    if (byte < 0x80) return 0
    if (byte >= 0xc0) return back < (byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2) ? back : 0
  }
  return 0
}

/** The header's names, each whole: a quoted name may hold doubled quotes, commas and newlines. */
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
  let token = text
  // A bare number has nothing to trim or unquote; only a token that starts or ends otherwise does.
  if (!bare(token.charCodeAt(0)) || !bare(token.charCodeAt(token.length - 1))) {
    token = token.trim()
    if (token[0] === '"' && token.at(-1) === '"') token = token.slice(1, -1).trim()
    if (token.length === 0) return NaN
  }
  // Number accepts hexadecimal, octal and binary literals; GridKit writes decimal numbers only.
  const prefix = token.charCodeAt(1) | 32
  if (!(token.charCodeAt(0) === 48 && (prefix === 120 || prefix === 111 || prefix === 98))) {
    const value = Number(token)
    if (!Number.isNaN(value)) return value
    if (/^[+-]?nan$/i.test(token)) return NaN
    if (/^[+-]?inf(?:inity)?$/i.test(token)) return token[0] === '-' ? -Infinity : Infinity
  }
  throw failure('io', `CSV frame ${frame}, column ${column} is not a number.`)
}

/** Whether `code` is a digit, a point or a sign: neither space nor quote. */
function bare(code: number): boolean {
  return (code >= 48 && code <= 57) || code === 46 || code === 45 || code === 43
}
