/** A results file followed as GridKit writes it: its header, then runs of whole frames. */

import { open } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

import { PROGRESS_MS, SEGMENT_BYTES } from './limits.js'

/** How long a follower waits before it looks again for a file, or for more of it. */
const POLL_MS = 40

/** A piece of a results file: its header line, or a segment, the bytes between `start` and `end`,
 *  which hold whole frames. */
export type Piece =
  | { readonly kind: 'header'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'segment'
      readonly start: number
      readonly end: number
      readonly bytes: Uint8Array
    }

/** The file at `path` as it is written, until `ended` and it has nothing more: its header, then each
 *  segment, every piece handled before more is read. A segment ends at the first row end past
 *  SEGMENT_BYTES. While the writer writes, one also ends at the last whole row read each time the
 *  views would hear of it, so a live run's frames come at its pace. */
export async function* follow(
  path: string,
  signal: AbortSignal,
  ended: () => boolean,
): AsyncGenerator<Piece> {
  let file
  while (!file) {
    signal.throwIfAborted()
    // Asked before opening: a writer done by then has made its file if it ever will.
    const over = ended()
    try {
      file = await open(path, 'r')
    } catch (error) {
      if (over) throw error
      await setTimeout(POLL_MS, undefined, { signal })
    }
  }
  try {
    /** How far the file has been read, and the bytes read past the last piece. */
    let at = 0
    let pending = Buffer.alloc(0)
    /** Where `pending` starts in the file. */
    let start = 0
    let header = false
    /** Where the search for the end of the CSV header, or of a segment, resumes in `pending`. */
    let scan = 0
    let quoted = false
    /** When the last segment was cut. The first is cut as soon as it can be. */
    let cutAt = -Infinity
    const cut = (length: number): Piece => {
      const segment = {
        kind: 'segment',
        start,
        end: start + length,
        bytes: pending.subarray(0, length),
      } as const
      start += length
      pending = pending.subarray(length)
      scan = 0
      cutAt = performance.now()
      return segment
    }
    // A wide run's frame is megabytes: reading a segment's worth at a time keeps a frame from being
    // gathered from many small reads.
    const buffer = Buffer.alloc(SEGMENT_BYTES)
    while (true) {
      signal.throwIfAborted()
      // Asked before reading: a writer done by then has written everything this read can see.
      const over = ended()
      const { bytesRead } = await file.read(buffer, 0, buffer.length, at)
      at += bytesRead
      const finished = over && bytesRead === 0
      if (bytesRead) pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)])
      // Only the header quotes; past it, a row ends at its newline.
      while (!header && scan < pending.length) {
        const byte = pending[scan++]!
        if (byte === 34) quoted = !quoted
        if (byte !== 10 || quoted) continue
        header = true
        // A copy: the header outlives the read it came in.
        yield { kind: 'header', bytes: new Uint8Array(pending.subarray(0, scan)) }
        start += scan
        pending = pending.subarray(scan)
        scan = 0
      }
      if (header) {
        while (pending.length >= SEGMENT_BYTES) {
          const newline = pending.indexOf(10, Math.max(scan, SEGMENT_BYTES - 1))
          if (newline < 0) {
            scan = pending.length
            break
          }
          yield cut(newline + 1)
        }
        // Once the writer is done, everything it wrote is a segment. Before, the whole rows read
        // so far are, whenever the views would next hear of them.
        const length = finished
          ? pending.length
          : !over && performance.now() - cutAt >= PROGRESS_MS
            ? pending.lastIndexOf(10) + 1
            : 0
        if (length) yield cut(length)
      }
      if (finished) {
        if (!header) throw new Error('Results contain no header.')
        return
      }
      if (!bytesRead) await setTimeout(POLL_MS, undefined, { signal })
    }
  } finally {
    await file.close()
  }
}
