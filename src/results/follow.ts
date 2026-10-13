/** A results file followed as GridKit writes it: its header, then runs of whole frames. */

import { type FileHandle, open } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { failure } from '@latkit/model'

import { PROGRESS_MS, SEGMENT_BYTES } from './limits.js'
import { same, type Stamp, stampOf } from './stamp.js'

/** How long a follower waits before it looks again for a file, or for more of it. */
const POLL_MS = 40
const QUOTE = 0x22
const COMMA = 0x2c
const RETURN = 0x0d
const NEWLINE = 0x0a

/** How the file's writer stands: writing still; done, all it wrote whole; or stopped, its last row
 *  maybe cut short. A file opened alone has no writer, and is done. */
export type Writer = 'writing' | 'done' | 'stopped'

/** A piece of a results file: its header line, with the file it is read from; a segment of whole
 *  frames; and, once it is read to its end, the file as it stood then, unless more came past what
 *  was read. */
export type Piece =
  | { readonly kind: 'header'; readonly bytes: Uint8Array; readonly stamp: Stamp }
  | { readonly kind: 'segment'; readonly bytes: Uint8Array }
  | { readonly kind: 'end'; readonly stamp?: Stamp }

/** The file at `path` as it is written, until `writer` is no longer writing and it has nothing more:
 *  its header, then each segment, every piece handled before more is read. A segment ends at the
 *  first row end past SEGMENT_BYTES. While the writer writes, one also ends at the last whole row
 *  read each time the views would hear of it, so a live run's frames come at its pace. A last row
 *  with no newline is the writer's own only when it is done. The file `last` stamps, which a run
 *  before left at `path`, is not the writer's until the writer writes it again. */
export async function* follow(
  path: string,
  signal: AbortSignal,
  writer: () => Writer,
  last?: Stamp,
): AsyncGenerator<Piece> {
  let file: FileHandle | undefined
  let opened!: Stamp
  while (!file) {
    signal.throwIfAborted()
    // Asked before opening: a writer done by then has made its file if it ever will.
    const over = writer() !== 'writing'
    try {
      const found = await open(path, 'r')
      try {
        opened = stampOf(await found.stat({ bigint: true }))
        if (same(opened, last))
          throw Object.assign(new Error(`${basename(path)} is what the last run left.`), {
            code: 'ENOENT',
          })
      } catch (error) {
        await found.close()
        throw error
      }
      file = found
    } catch (error) {
      if (over) throw error
      await setTimeout(POLL_MS, undefined, { signal })
    }
  }
  try {
    /** The bytes read and not yet given, `from` to `to` of `buffer`, which grows to hold a row. */
    let buffer = Buffer.allocUnsafe(2 * SEGMENT_BYTES)
    let from = 0
    let to = 0
    /** How far the file has been read. */
    let at = 0
    let header = false
    /** Where the search for the header's end, or a segment's, resumes in `buffer`. */
    let scan = 0
    let quoted = false
    /** Whether the byte before `scan` closed a quoted name. */
    let closing = false
    /** When the last segment was cut. The first is cut as soon as it can be. */
    let cutAt = -Infinity
    const cut = (length: number): Piece => {
      const bytes = buffer.subarray(from, from + length)
      from += length
      scan = from
      cutAt = performance.now()
      return { kind: 'segment', bytes }
    }
    while (true) {
      signal.throwIfAborted()
      // Asked before reading: a writer done by then has written everything this read can see.
      const state = writer()
      // Room for a segment's worth past what is held: moved to the front, or a larger buffer.
      if (buffer.length - to < SEGMENT_BYTES) {
        const held = to - from
        const next =
          held + SEGMENT_BYTES > buffer.length
            ? Buffer.allocUnsafe(2 * (held + SEGMENT_BYTES))
            : buffer
        buffer.copy(next, 0, from, to)
        scan -= from
        buffer = next
        from = 0
        to = held
      }
      const room = buffer.length - to
      const { bytesRead } = await file.read(buffer, to, room, at)
      at += bytesRead
      to += bytesRead
      const finished = state !== 'writing' && bytesRead === 0
      // Only the header quotes; past it, a row ends at its newline.
      for (; !header && scan < to; scan++) {
        const byte = buffer[scan]!
        if (closing && byte !== QUOTE && byte !== COMMA && byte !== RETURN && byte !== NEWLINE)
          throw failure('io', 'The CSV header has an invalid quoted name.')
        closing = false
        if (byte === QUOTE) {
          quoted = !quoted
          closing = !quoted
        }
        if (byte !== NEWLINE || quoted) continue
        header = true
        // A copy: the header outlives the read it came in.
        yield {
          kind: 'header',
          bytes: new Uint8Array(buffer.subarray(from, scan + 1)),
          stamp: opened,
        }
        from = scan + 1
      }
      if (header) {
        while (to - from >= SEGMENT_BYTES) {
          const newline = buffer.indexOf(NEWLINE, Math.max(scan, from + SEGMENT_BYTES - 1))
          if (newline < 0 || newline >= to) {
            scan = to
            break
          }
          yield cut(newline + 1 - from)
        }
        // Once the writer is done, everything it wrote is a segment; once it stopped, its whole
        // rows. Before, the whole rows read so far are, whenever the views would next hear of them.
        const rows = () => buffer.subarray(from, to).lastIndexOf(NEWLINE) + 1
        const length = finished
          ? state === 'done'
            ? to - from
            : rows()
          : state === 'writing' && performance.now() - cutAt >= PROGRESS_MS
            ? rows()
            : 0
        if (length) yield cut(length)
      }
      if (finished) {
        if (!header) throw new Error('Results contain no header.')
        const stamp = stampOf(await file.stat({ bigint: true }))
        yield { kind: 'end', ...(stamp.size === at && { stamp }) }
        return
      }
      // A read short of the room caught up with the writer, which is given time to write more.
      if (bytesRead < room && state === 'writing') await setTimeout(POLL_MS, undefined, { signal })
    }
  } finally {
    await file.close()
  }
}
