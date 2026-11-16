/** Parses GridKit's numeric CSV results: the wide layout (a column per variable) or the long layout
 *  (a row per variable and sample), both read as wide rows. */
import { concat } from '../platform/bytes.js'
import { problem } from '../shared/errors.js'
import { BATCH_BYTES } from './limits.js'

/** The columns of GridKit's long layout, in any order among other columns. */
const LONG = ['sample', 't', 'class', 'id', 'variable', 'value'] as const

/** The indexes of the LONG columns in a header of `width` names. */
export interface LongColumns {
  readonly at: readonly number[]
  readonly width: number
}

/** Long-layout parse state carried from one read to the next. Variables keep first-sample order. */
export interface LongReading {
  readonly columns: LongColumns
  readonly names: string[]
  places?: ReadonlyMap<string, number>
  /** The sample in progress (-1 between samples), its time, its values, and how many are filled. */
  sample: number
  time: number
  values: number[]
  filled: number
  pending: string
}

/** The state at the start of a file, or with `names`, after complete samples of those variables. */
export const longReading = (columns: LongColumns, names?: readonly string[]): LongReading => ({
  columns,
  names: names ? [...names] : [],
  ...(names && { places: new Map(names.map((name, place) => [name, place])) }),
  sample: -1,
  time: NaN,
  values: [],
  filled: 0,
  pending: '',
})

function longColumns(names: readonly string[]): LongColumns | undefined {
  const at = LONG.map((name) => names.indexOf(name))
  return at.every((place) => place >= 0) ? { at, width: names.length } : undefined
}

type CsvMessage =
  | { readonly kind: 'schema'; readonly names: readonly string[] }
  | {
      readonly kind: 'rows'
      readonly length: number
      /** `length` rows of `width` numbers, row-major. */
      readonly values: Float64Array
      readonly width: number
    }

/** Yields the header, then batches of rows in a reused buffer, so consume each before advancing.
 *  With `known` header names, `source` has rows only. A truncated last row is skipped. */
export async function* csvMessages(
  source: AsyncIterable<Uint8Array>,
  known?: readonly string[],
  first = 0,
  state: { long?: LongReading } = {},
  final = false,
): AsyncGenerator<CsvMessage> {
  let header = ''
  let quoted = false
  let headed = false
  let values = new Float64Array(0)
  let width = 0
  let capacity = 0
  let column = 0
  let rows = 0
  let received = first
  let pending = ''
  const schema = (names: readonly string[]): CsvMessage => {
    headed = true
    width = names.length
    capacity = Math.max(1, Math.floor(BATCH_BYTES / (8 * width)))
    return { kind: 'schema', names }
  }
  if (known) yield schema(known)
  const texts = textChunks(source)
  if (state.long) {
    yield* longMessages(texts, state.long, first, final)
    return
  }

  for await (const [text, closing] of texts) {
    let start = 0
    if (!headed) {
      for (; start < text.length; start++) {
        const code = text.charCodeAt(start)
        if (code === 34) quoted = !quoted
        if (code === 10 && !quoted) break
      }
      header += text.slice(0, start)
      if (start === text.length) continue
      const names = headerOf(header)
      const long = longColumns(names)
      if (long) {
        state.long = longReading(long)
        yield* longMessages(
          prepend([text.slice(start + 1), closing], texts),
          state.long,
          first,
          final,
        )
        return
      }
      if (!/^(t|time)$/i.test(names[0]!))
        throw problem('io', 'The first CSV column must be t or time.')
      yield schema(names)
      header = ''
      start++
    }

    // Cache the next newline. Searching for it after every comma is quadratic in a wide case.
    let newline = text.indexOf('\n', start)
    let comma = text.indexOf(',', start)
    while (start < text.length) {
      const end = comma < 0 ? newline : newline < 0 ? comma : Math.min(comma, newline)
      if (end < 0) {
        pending += text.slice(start)
        break
      }
      const carried = pending
      const token = carried + text.slice(start, end)
      pending = ''
      const last = end === newline
      start = end + 1
      if (last) newline = text.indexOf('\n', start)
      else comma = text.indexOf(',', start)
      if (last && column === 0 && token.trim() === '') continue
      // The closing newline completes a row missing only its newline. Any other cut row is skipped.
      if (closing && (column !== width - 1 || carried === '')) break
      if (column >= width || (last && column !== width - 1))
        throw problem('io', `CSV row ${received + rows + 1} does not match its header.`)
      const value = numberOf(token, received + rows + 1, column + 1)
      if (column === 0) {
        if (!Number.isFinite(value)) throw problem('io', 'Every CSV row needs a finite time.')
        // Grow the buffer as rows arrive, so a page of a few rows allocates little.
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
  if (!headed) throw problem('io', 'The CSV results do not have a complete header.')
  if (rows > 0) yield { kind: 'rows', length: rows, values, width }
}

async function* prepend(
  head: readonly [string, boolean],
  texts: AsyncIterable<readonly [string, boolean]>,
): AsyncGenerator<readonly [string, boolean]> {
  yield head
  yield* texts
}

/** Converts complete long-layout samples into wide rows. The schema comes once the first sample
 *  ends, and a truncated last sample is skipped. */
async function* longMessages(
  texts: AsyncIterable<readonly [string, boolean]>,
  long: LongReading,
  first: number,
  final: boolean,
): AsyncGenerator<CsvMessage> {
  const out: number[] = []
  let frames = first
  const learn = (): CsvMessage => {
    long.places = new Map(long.names.map((name, place) => [name, place]))
    if (long.places.size !== long.names.length)
      throw problem('io', 'The first sample of the long results names a variable twice.')
    return { kind: 'schema', names: ['t', ...long.names] }
  }
  const close = () => {
    // One at a time: a sample can be too wide to spread into a single call's arguments.
    out.push(long.time)
    for (const value of long.values) out.push(value)
    frames++
    long.sample = -1
    long.values = []
    long.filled = 0
  }
  const { at, width } = long.columns
  for await (const [text, closing] of texts) {
    const lines = (long.pending + text).split('\n')
    long.pending = lines.pop()!
    for (const line of lines) {
      const row = line.endsWith('\r') ? line.slice(0, -1) : line
      if (!row) continue
      const cells = row.split(',')
      if (cells.length !== width) {
        // The closing newline ends a row the writer cut short, which is skipped.
        if (closing) break
        throw problem('io', `CSV row ${frames + 1} does not match its header.`)
      }
      const [sample, t, kind, id, variable, written] = at.map((place) => cells[place]!)
      const number = Number(sample)
      if (!Number.isSafeInteger(number) || number < 0)
        throw problem('io', `CSV row ${frames + 1} names no sample.`)
      if (number !== long.sample) {
        if (long.sample >= 0) {
          if (!long.places) yield learn()
          close()
        }
        long.sample = number
        long.time = numberOf(t!, frames + 1, at[1]! + 1)
        if (!Number.isFinite(long.time)) throw problem('io', 'Every CSV row needs a finite time.')
        if (long.places) long.values = new Array<number>(long.names.length).fill(NaN)
      }
      const name = `${kind}_${id}_${variable}`
      const value = numberOf(written!, frames + 1, at[5]! + 1)
      if (!long.places) {
        long.names.push(name)
        long.values.push(value)
        continue
      }
      const place = long.places.get(name)
      if (place === undefined)
        throw problem('io', `Sample ${sample} records ${name}, which the first sample does not.`)
      long.values[place] = value
      if (++long.filled === long.names.length) close()
    }
    // When the file ends, its only sample is complete.
    if (final && closing && !long.places && long.sample >= 0) {
      yield learn()
      close()
    }
    if (out.length && long.places) {
      const wide = long.names.length + 1
      yield { kind: 'rows', length: out.length / wide, values: Float64Array.from(out), width: wide }
      out.length = 0
    }
  }
}

/** Decodes `source` as UTF-8, then yields a closing newline flagged true. Decoding each part whole
 *  is several times faster than streaming. */
async function* textChunks(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<readonly [string, boolean]> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let carried: Uint8Array = new Uint8Array(0)
  for await (const part of source) {
    const bytes = carried.length ? concat(carried, part) : part
    const end = bytes.length - unfinished(bytes)
    carried = bytes.slice(end)
    let text: string
    try {
      text = decoder.decode(bytes.subarray(0, end))
    } catch {
      throw problem('io', 'The CSV results are not valid UTF-8.')
    }
    yield [text, false]
  }
  if (carried.length) throw problem('io', 'The CSV results end inside a UTF-8 character.')
  yield ['\n', true]
}

/** How many trailing bytes belong to an incomplete UTF-8 character. */
function unfinished(bytes: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back]!
    if (byte < 0x80) return 0
    if (byte >= 0xc0) return back < (byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2) ? back : 0
  }
  return 0
}

/** A quoted name may contain doubled quotes, commas and newlines. */
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
        throw problem('io', 'The CSV header has an invalid quoted name.')
    } else {
      const end = text.indexOf(',', start)
      const stop = end < 0 ? text.length : end
      name = text.slice(start, stop)
      if (name.includes('"'))
        throw problem('io', 'The CSV header has a quote inside an unquoted name.')
      start = stop
    }
    if (name.length === 0) throw problem('io', 'The CSV header has an empty column name.')
    names.push(name)
    if (start === text.length) break
    start++
  }
  return names
}

/** NaN and infinity as C libraries print them, including MSVC's `-nan(ind)`, `1.#QNAN` and
 *  `-1.#INF`. */
const NAN = /^[+-]?(?:nan(?:\(\w*\))?|1\.#(?:s|q)?nan|1\.#ind)$/i
const INFINITY = /^[+-]?(?:inf(?:inity)?|1\.#inf)$/i

function numberOf(text: string, frame: number, column: number): number {
  let token = text
  // Only a token that does not start and end like a bare number needs trimming or unquoting.
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
    if (NAN.test(token)) return NaN
    if (INFINITY.test(token)) return token[0] === '-' ? -Infinity : Infinity
  }
  throw problem('io', `CSV row ${frame}, column ${column} is not a number.`)
}

function bare(code: number): boolean {
  return (code >= 48 && code <= 57) || code === 46 || code === 45 || code === 43
}
