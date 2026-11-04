/** Where a byte of a case's file is in its text, as VS Code counts: in UTF-16 units, and by line and
 *  character. One way for every reader, keyed by the file's bytes. */

import { isAscii } from 'node:buffer'

import type { SourceRange } from '../shared/messages.js'

const decoder = new TextDecoder()
/** How far apart checkpoints are, at least, in bytes. */
const STEP = 4096
/** How far a walk through the file counts on, character by character, before it jumps instead from
 *  the nearest checkpoint. */
const WALK_BYTES = 4096
const LINE_FEED = 0x0a

/** A stretch of a case's text: from a UTF-16 offset, so many units long. */
export interface Span {
  readonly offset: number
  readonly length: number
}

/** The bytes checkpoints land on, each on a character's first byte, and the characters before
 *  each. */
interface Checkpoints {
  readonly bytes: number[]
  readonly chars: number[]
}

/** Each file's checkpoints, or null for a file all ASCII, whose bytes are its characters. */
const known = new WeakMap<Uint8Array, Checkpoints | null>()
/** Each file's line starts, as UTF-16 offsets, found the first time a place in it is asked for. */
const lines = new WeakMap<Uint8Array, Uint32Array>()

/** How many bytes the UTF-8 character whose first byte is `first` takes; one of four takes two
 *  UTF-16 units, the others one. */
const widthOf = (first: number) => (first < 128 ? 1 : first < 224 ? 2 : first < 240 ? 3 : 4)

function checkpointsOf(file: Uint8Array): Checkpoints | null {
  let found = known.get(file)
  if (found !== undefined) return found
  if (isAscii(file)) found = null
  else {
    found = { bytes: [0], chars: [0] }
    let chars = 0
    let next = STEP
    for (let at = 0; at < file.length;) {
      const width = widthOf(file[at]!)
      at += width
      chars += width === 4 ? 2 : 1
      if (at >= next) {
        found.bytes.push(at)
        found.chars.push(chars)
        next = at + STEP
      }
    }
  }
  known.set(file, found)
  return found
}

/** The UTF-16 offset of `byte` in `file`: from the checkpoint before it, only the bytes past it
 *  decoded. */
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

/** The UTF-16 offsets of ascending byte offsets of `file`: each counted on from the last, near, or
 *  found from a checkpoint, far; so a walk through the file is linear however many it asks for. */
export function charsWalk(file: Uint8Array): (byte: number) => number {
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
  let starts = lines.get(file)
  if (starts) return starts
  let count = 1
  for (let at = file.indexOf(LINE_FEED); at >= 0; at = file.indexOf(LINE_FEED, at + 1)) count++
  starts = new Uint32Array(count)
  const chars = charsWalk(file)
  let line = 0
  for (let at = file.indexOf(LINE_FEED); at >= 0; at = file.indexOf(LINE_FEED, at + 1))
    starts[++line] = chars(at + 1)
  lines.set(file, starts)
  return starts
}

/** The line and character of UTF-16 offset `chars` in `file`. */
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

/** Where `span` of `file` is, as VS Code counts: by line, and by character along it. */
export const rangeIn = (file: Uint8Array, { offset, length }: Span): SourceRange => ({
  start: positionOf(file, offset),
  end: positionOf(file, offset + length),
})
