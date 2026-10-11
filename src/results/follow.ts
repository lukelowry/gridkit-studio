/** A results file followed as GridKit writes it: its header, then runs of whole frames. */

import { open } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

import { parseMessage } from './arrow.js'
import { PROGRESS_MS, SEGMENT_BYTES } from './limits.js'

/** A piece of a results file: its header, the CSV header line or the Arrow schema message; or a
 *  segment, the bytes between `start` and `end`, which hold whole frames. */
export type Piece =
  | { readonly kind: 'header'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'segment'
      readonly start: number
      readonly end: number
      readonly bytes: Uint8Array
    }

/** The file at `path` as it is written, until `ended` and it has nothing more: its header, then each
 *  segment, every piece handled before more is read. A CSV segment ends at the first row end past
 *  SEGMENT_BYTES. While the writer writes, one also ends at the last whole row read each time the
 *  views would hear of it, so a live run's frames come at its pace. An Arrow segment is one record
 *  batch. */
export async function* follow(
  path: string,
  format: 'csv' | 'arrow',
  signal: AbortSignal,
  ended: () => boolean,
): AsyncGenerator<Piece> {
  let file
  while (!file) {
    signal.throwIfAborted()
    try {
      file = await open(path, 'r')
    } catch (error) {
      if (ended()) throw error
      await setTimeout(40, undefined, { signal })
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
    // A wide run's frame is megabytes: reading in pieces that large keeps a frame from being
    // gathered from many small reads.
    const buffer = Buffer.alloc(4 << 20)
    /** Reads not yet joined onto `pending`, and how long `pending` must grow before a piece can end
     *  in it: an Arrow message larger than a read is joined once, when all of it is here, not again
     *  at every read. */
    let reads: Buffer[] = []
    let readBytes = 0
    let needed = 0
    while (true) {
      signal.throwIfAborted()
      // Asked before reading: a writer done by then has written everything this read can see.
      const over = ended()
      const { bytesRead } = await file.read(buffer, 0, buffer.length, at)
      at += bytesRead
      const finished = over && bytesRead === 0
      if (!finished && pending.length + readBytes + bytesRead < needed) {
        // The read buffer is reused, so a read kept for later is a copy.
        if (bytesRead) {
          reads.push(Buffer.from(buffer.subarray(0, bytesRead)))
          readBytes += bytesRead
        } else await setTimeout(40, undefined, { signal })
        continue
      }
      if (bytesRead || readBytes) {
        pending = Buffer.concat([pending, ...reads, buffer.subarray(0, bytesRead)])
        reads = []
        readBytes = 0
      }
      needed = 0
      if (format === 'arrow') {
        while (pending.length >= 8) {
          const continuation = pending.readUInt32LE(0) === 0xffffffff
          const prefix = continuation ? 8 : 4
          const metadataLength = pending.readUInt32LE(continuation ? 4 : 0)
          if (!metadataLength) {
            start += prefix
            pending = pending.subarray(prefix)
            break
          }
          if (pending.length < prefix + metadataLength) {
            needed = prefix + metadataLength
            break
          }
          const message = parseMessage(pending.subarray(prefix, prefix + metadataLength))
          const length = prefix + metadataLength + message.bodyLength
          if (!Number.isSafeInteger(message.bodyLength) || message.bodyLength < 0)
            throw new Error('An Arrow message has an invalid body length.')
          if (pending.length < length) {
            needed = length
            break
          }
          if (message.header.kind === 'batch') {
            yield cut(length)
            continue
          }
          if (message.header.kind === 'schema') {
            if (header) throw new Error('Repeated Arrow schema.')
            header = true
            yield { kind: 'header', bytes: pending.subarray(0, length).slice() }
          }
          start += length
          pending = pending.subarray(length)
        }
      } else {
        // Only the header quotes; past it, a row ends at its newline.
        while (!header && scan < pending.length) {
          const byte = pending[scan++]!
          if (byte === 34) quoted = !quoted
          if (byte !== 10 || quoted) continue
          header = true
          yield { kind: 'header', bytes: pending.subarray(0, scan).slice() }
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
      }
      if (finished) {
        if (format === 'arrow' && pending.length)
          throw new Error('Results ended inside an Arrow message.')
        if (!header) throw new Error('Results contain no header.')
        return
      }
      if (!bytesRead) await setTimeout(40, undefined, { signal })
    }
  } finally {
    await file.close()
  }
}
