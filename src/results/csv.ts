/** GridKit's numeric CSV results, under a header of UTF-8 names: a column per variable (its wide
 *  layout), or a row per variable and sample (its long layout), read as the wide. */
import { problem } from '../shared/errors.js'
import { BATCH_BYTES } from './limits.js'

/** The columns of GridKit's long layout, which a header names in any order among others. */
const LONG = ['sample', 't', 'class', 'id', 'variable', 'value'] as const

/** Where a long layout's columns are, in LONG's order, among its header's `width` names. */
export interface LongColumns {
  readonly at: readonly number[]
  readonly width: number
}

/** A long-layout file's reading, carried from one read of it to the next: its columns; its
 *  variables, named as the wide layout's columns are, in its first sample's order, and each one's
 *  place once that sample is whole; the sample being gathered; and a line a read ends partway
 *  through. */
export interface LongReading {
  readonly columns: LongColumns
  readonly names: string[]
  places?: ReadonlyMap<string, number>
  /** The sample being gathered, -1 between samples, its time, its values, and how many it has. */
  sample: number
  time: number
  values: number[]
  filled: number
  pending: string
}

/** A long layout's reading from its start, or, with `names`, past whole samples of those variables. */
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

/** Where the long layout's columns are among a header's `names`, or undefined when one is missing. */
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

/** The header, then batches of rows whose values are reused, so consume each before advancing.
 *  `known` is the header's names, when another read of the same results parsed it: `source` is
 *  then rows alone, the first of them frame `first` of the file, as a problem numbers it. A last
 *  row cut short, as a writer that was stopped leaves it, is left out. A long layout's reading is
 *  kept in `held`, which says so for a read past its header; `final` says `source` ends the file. */
export async function* csvMessages(
  source: AsyncIterable<Uint8Array>,
  known?: readonly string[],
  first = 0,
  held: { long?: LongReading } = {},
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
  /** The frames before this batch's, counted from the file's first. */
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
  if (held.long) {
    yield* longMessages(texts, held.long, first, final)
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
        held.long = longReading(long)
        yield* longMessages(after([text.slice(start + 1), closing], texts), held.long, first, final)
        return
      }
      if (!/^(t|time)$/i.test(names[0]!))
        throw problem('io', 'The first CSV column must be t or time.')
      yield schema(names)
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
      const carried = pending
      const token = carried + text.slice(start, end)
      pending = ''
      const last = end === newline
      start = end + 1
      if (last) newline = text.indexOf('\n', start)
      else comma = text.indexOf(',', start)
      if (last && column === 0 && token.trim() === '') continue
      // The newline that closes the source ends a row only its writer's newline is missing from;
      // one cut short, or cut after its last comma, it never finished.
      if (closing && (column !== width - 1 || carried === '')) break
      if (column >= width || (last && column !== width - 1))
        throw problem('io', `CSV frame ${received + rows + 1} does not match its header.`)
      const value = numberOf(token, received + rows + 1, column + 1)
      if (column === 0) {
        if (!Number.isFinite(value)) throw problem('io', 'A CSV frame must have a finite time.')
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
  if (!headed) throw problem('io', 'The CSV results do not have a complete header.')
  if (rows > 0) yield { kind: 'rows', length: rows, values, width }
}

/** `head`, then the rest of `texts`. */
async function* after(
  head: readonly [string, boolean],
  texts: AsyncIterable<readonly [string, boolean]>,
): AsyncGenerator<readonly [string, boolean]> {
  yield head
  yield* texts
}

/** A long layout's whole samples in `texts`, which `long` reads on from, each a row as the wide
 *  layout writes it: the schema first, once the first sample is whole, which the next sample's
 *  first row says, or the file's end. A sample is whole once it has a value of every variable, or
 *  the next begins; a value it lacks is NaN. A last sample the file ends partway through is left
 *  out, as a cut wide row is. Event times repeat, as samples before and after the event. */
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
    out.push(long.time, ...long.values)
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
        // The newline that closes the source ends a row its writer cut short; it never finished.
        if (closing) break
        throw problem('io', `Long results row ${frames + 1} does not match its header.`)
      }
      const [sample, t, kind, id, variable, written] = at.map((place) => cells[place]!)
      const number = Number(sample)
      if (!Number.isSafeInteger(number) || number < 0)
        throw problem('io', `Long results row ${frames + 1} names no sample.`)
      if (number !== long.sample) {
        if (long.sample >= 0) {
          if (!long.places) yield learn()
          close()
        }
        long.sample = number
        long.time = numberOf(t!, frames + 1, at[1]! + 1)
        if (!Number.isFinite(long.time)) throw problem('io', 'A CSV frame must have a finite time.')
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
    // A file's only sample is whole once the file ends.
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

/** `source` as text, then a closing newline to end a last record that has none, each with whether
 *  it is that newline. Each part is decoded whole, several times faster than streaming, once the
 *  bytes of a character it ends partway through are carried to the next. */
async function* textChunks(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<readonly [string, boolean]> {
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
      throw problem('io', 'The CSV results are not valid UTF-8.')
    }
    yield [text, false]
  }
  if (carried.length) throw problem('io', 'The CSV results end inside a UTF-8 character.')
  yield ['\n', true]
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

/** A value that is not a number, and an infinite one, however a C library prints them. */
const NAN = /^[+-]?(?:nan(?:\(\w*\))?|1\.#(?:s|q)?nan|1\.#ind)$/i
const INFINITY = /^[+-]?(?:inf(?:inity)?|1\.#inf)$/i

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
    // As C libraries print them, MSVC's among them: `-nan(ind)`, `1.#QNAN`, `-1.#INF`.
    if (NAN.test(token)) return NaN
    if (INFINITY.test(token)) return token[0] === '-' ? -Infinity : Infinity
  }
  throw problem('io', `CSV frame ${frame}, column ${column} is not a number.`)
}

/** Whether `code` is a digit, a point or a sign: neither space nor quote. */
function bare(code: number): boolean {
  return (code >= 48 && code <= 57) || code === 46 || code === 45 || code === 43
}
