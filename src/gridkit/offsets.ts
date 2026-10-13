/** Where a byte of a case's file is in its text, as VS Code counts: in UTF-16 units. One way for
 *  every reader, keyed by the file's bytes. */

import { isAscii } from 'node:buffer'

const decoder = new TextDecoder()
/** How far apart checkpoints are, at least, in bytes. */
const STEP = 4096
/** How far a walk through the file counts on, character by character, before it jumps instead from
 *  the nearest checkpoint. */
const WALK_BYTES = 4096

/** The bytes checkpoints land on, each on a character's first byte, and the characters before
 *  each. */
interface Checkpoints {
  readonly bytes: number[]
  readonly chars: number[]
}

/** Each file's checkpoints, or null for a file all ASCII, whose bytes are its characters. */
const known = new WeakMap<Uint8Array, Checkpoints | null>()

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

/** The byte of `file` its UTF-16 offset `chars` is at: where the character there starts, or the
 *  next character, should the offset land between the two units of one. */
export function bytesAt(file: Uint8Array, chars: number): number {
  const map = checkpointsOf(file)
  if (!map) return chars
  let low = 0
  let high = map.chars.length
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    if (map.chars[middle]! <= chars) low = middle
    else high = middle
  }
  let byte = map.bytes[low]!
  for (let count = map.chars[low]!; count < chars && byte < file.length;) {
    const width = widthOf(file[byte]!)
    byte += width
    count += width === 4 ? 2 : 1
  }
  return byte
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

/** Gives `after`, which differs from `before` only from byte `start`, up to `ended` there and `ends`
 *  here, the checkpoints `before` has: those before the edit kept, those past it moved, so the
 *  first offset asked of `after` never walks it whole, nor looks again whether it is all ASCII. */
export function carryOffsets(
  before: Uint8Array,
  after: Uint8Array,
  { start, ended, ends }: { readonly start: number; readonly ended: number; readonly ends: number },
): void {
  const old = known.get(before)
  if (old === undefined || known.has(after)) return
  // A file all ASCII stays so where the edit wrote ASCII alone.
  if (old === null) {
    if (isAscii(after.subarray(start, ends))) known.set(after, null)
    return
  }
  const kept = old.bytes.findLastIndex((byte) => byte <= start)
  const bytes = old.bytes.slice(0, kept + 1)
  const chars = old.chars.slice(0, kept + 1)
  const next = old.bytes.findIndex((byte) => byte >= ended)
  if (next >= 0) {
    const grown = ends - ended
    const there = old.bytes[next]! + grown
    const moved =
      chars[kept]! + decoder.decode(after.subarray(bytes[kept]!, there)).length - old.chars[next]!
    for (let i = next; i < old.bytes.length; i++) {
      bytes.push(old.bytes[i]! + grown)
      chars.push(old.chars[i]! + moved)
    }
  }
  known.set(after, { bytes, chars })
}
