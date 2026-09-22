import type { FileHandle } from 'node:fs/promises'

import { MAX_COLUMNS, MAX_RECORD_BYTES } from './limits.js'

export const CHUNK_BYTES = 256 * 1024
/** Byte offsets refer to the original file, including CRLF. Incomplete live rows stay unread. */
export async function* lines(
  file: FileHandle,
  start: number,
  end: number,
  final: boolean,
  signal?: AbortSignal,
) {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
  let position = start
  let rowStart = start
  let parts: Buffer[] = []
  let length = 0
  while (position < end) {
    signal?.throwIfAborted()
    const { bytesRead } = await file.read(
      chunk,
      0,
      Math.min(chunk.length, end - position),
      position,
    )
    if (!bytesRead) break
    let from = 0
    for (let i = 0; i < bytesRead; i++) {
      if (chunk[i] !== 10) continue
      const tail = chunk.subarray(from, i)
      if (length + tail.length > MAX_RECORD_BYTES)
        throw new RangeError('CSV record exceeds 16 MiB.')
      const row = parts.length ? Buffer.concat([...parts, tail], length + tail.length) : tail
      yield {
        text: row.toString('utf8').replace(/\r$/, ''),
        offset: rowStart,
        end: position + i + 1,
      }
      parts = []
      length = 0
      from = i + 1
      rowStart = position + from
    }
    if (from < bytesRead) {
      if (length + bytesRead - from > MAX_RECORD_BYTES)
        throw new RangeError('CSV record exceeds 16 MiB.')
      const part = Buffer.from(chunk.subarray(from, bytesRead))
      parts.push(part)
      length += part.length
    }
    position += bytesRead
  }
  if (final && length)
    yield {
      text: Buffer.concat(parts, length).toString('utf8').replace(/\r$/, ''),
      offset: rowStart,
      end: position,
    }
}
export function header(text: string): string[] {
  const values: string[] = []
  let value = ''
  let quoted = false
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"'
        i++
      } else quoted = !quoted
    } else if (c === ',' && !quoted) {
      if (values.length >= MAX_COLUMNS) throw new RangeError('Too many CSV columns.')
      values.push(value)
      value = ''
    } else value += c
  }
  if (quoted) throw new Error('Incomplete CSV header.')
  if (values.length >= MAX_COLUMNS) throw new RangeError('Too many CSV columns.')
  values.push(value)
  if (values[0] !== 't' || values.length < 2)
    throw new Error('Expected a GridKit CSV header beginning with t.')
  return values
}
function numeric(text: string): number {
  if (!text.trim()) return NaN
  if (/^[+-]?(nan|inf(?:inity)?)$/i.test(text))
    return /nan/i.test(text) ? NaN : text[0] === '-' ? -Infinity : Infinity
  const value = Number(text)
  if (Number.isNaN(value)) throw new Error(`Invalid numeric CSV value: ${text.slice(0, 60)}`)
  return value
}
/** Parse only requested columns; the time and record width are always checked. */
export function decoder(width: number, columns: readonly number[] | null) {
  const wanted = new Map<number, number[]>()
  columns?.forEach((column, i) => {
    const indices = wanted.get(column)
    if (indices) indices.push(i)
    else wanted.set(column, [i])
  })
  return (text: string): { time: number; values: Float64Array } => {
    const values = new Float64Array(columns?.length ?? width - 1).fill(NaN)
    let start = 0
    let count = 0
    let time = NaN
    for (let end = 0; end <= text.length; end++)
      if (end === text.length || text.charCodeAt(end) === 44) {
        const at = wanted.get(count)
        if (count === 0) time = numeric(text.slice(start, end))
        if (columns === null && count > 0) values[count - 1] = numeric(text.slice(start, end))
        if (at) {
          const value = numeric(text.slice(start, end))
          for (const index of at) values[index] = value
        }
        count++
        start = end + 1
      }
    if (count !== width) throw new Error(`CSV record has ${count} columns; expected ${width}.`)
    if (!Number.isFinite(time)) throw new Error('CSV time must be finite.')
    return { time, values }
  }
}
