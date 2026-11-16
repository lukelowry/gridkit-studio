/** Maps byte offsets in a case file to VS Code's UTF-16 offsets and line positions. */

import type { SourceRange } from '../shared/messages.js'
import { grown } from './columns.js'

const decoder = new TextDecoder()
const STEP = 4096
/** How far a sequential walk counts forward before jumping from a checkpoint instead. */
const WALK_BYTES = 4096
const LINE_FEED = 0x0a

/** A range of a case's text, in UTF-16 units. */
export interface Span {
  readonly offset: number
  readonly length: number
}

interface Checkpoints {
  readonly bytes: number[]
  readonly chars: number[]
}

/** Checkpoints per file, or null for an all-ASCII file, where bytes and characters coincide. */
const checkpointCache = new WeakMap<Uint8Array, Checkpoints | null>()
const lineCache = new WeakMap<Uint8Array, Uint32Array>()

/** The byte length of the UTF-8 character starting with `first`. */
const widthOf = (first: number) => (first < 128 ? 1 : first < 224 ? 2 : first < 240 ? 3 : 4)

function checkpointsOf(file: Uint8Array): Checkpoints | null {
  let found = checkpointCache.get(file)
  if (found !== undefined) return found
  const checkpoints: Checkpoints = { bytes: [0], chars: [0] }
  let ascii = true
  let chars = 0
  let next = STEP
  for (let at = 0; at < file.length;) {
    // Skip a run of ASCII, then the non-ASCII character that ends it, if any.
    const run = at
    const stop = Math.min(next, file.length)
    while (at < stop && file[at]! < 128) at++
    chars += at - run
    if (at < stop) {
      ascii = false
      const width = widthOf(file[at]!)
      at += width
      chars += width === 4 ? 2 : 1
    }
    if (at >= next) {
      checkpoints.bytes.push(at)
      checkpoints.chars.push(chars)
      next = at + STEP
    }
  }
  found = ascii ? null : checkpoints
  checkpointCache.set(file, found)
  return found
}

/** The UTF-16 offset of `byte` in `file`, decoding only from the nearest checkpoint before it. */
export function charsAt(file: Uint8Array, byte: number): number {
  const map = checkpointsOf(file)
  if (!map) return byte
  let low = 0
  let high = map.bytes.length
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    if (map.bytes[middle]! <= byte) low = middle
    else high = middle
  }
  return map.chars[low]! + decoder.decode(file.subarray(map.bytes[low]!, byte)).length
}

/** Converts ascending byte offsets of `file`. A nearby offset counts forward from the last one and
 *  a distant one starts from a checkpoint, so a full walk stays linear. */
function charsWalk(file: Uint8Array): (byte: number) => number {
  if (!checkpointsOf(file)) return (byte) => byte
  let byte = -1
  let chars = 0
  return (to) => {
    if (byte < 0 || to < byte || to - byte > WALK_BYTES) {
      byte = to
      return (chars = charsAt(file, to))
    }
    for (; byte < to; chars++) {
      const width = widthOf(file[byte]!)
      byte += width
      if (width === 4) chars++
    }
    return chars
  }
}

function lineStarts(file: Uint8Array): Uint32Array {
  let starts = lineCache.get(file)
  if (starts) return starts
  starts = new Uint32Array(1024)
  const chars = charsWalk(file)
  let count = 1
  for (let at = file.indexOf(LINE_FEED); at >= 0; at = file.indexOf(LINE_FEED, at + 1)) {
    if (count === starts.length) starts = grown(starts)
    starts[count++] = chars(at + 1)
  }
  starts = starts.slice(0, count)
  lineCache.set(file, starts)
  return starts
}

function positionOf(file: Uint8Array, chars: number): [line: number, character: number] {
  const starts = lineStarts(file)
  let low = 0
  let high = starts.length
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    if (starts[middle]! <= chars) low = middle
    else high = middle
  }
  return [low, chars - starts[low]!]
}

export const rangeIn = (file: Uint8Array, { offset, length }: Span): SourceRange => ({
  start: positionOf(file, offset),
  end: positionOf(file, offset + length),
})
