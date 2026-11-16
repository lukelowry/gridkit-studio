/** Follows a results file as GridKit writes it: the header, then segments of whole frames. */
import { type FileHandle, open } from '../platform/files.js'
import { basename } from '../platform/path.js'
import { setTimeout } from '../platform/timing.js'
import { problem } from '../shared/errors.js'
import { PROGRESS_MS, SEGMENT_BYTES } from './limits.js'
import { same, type Stamp, stampAt, stampOf } from './stamp.js'

export const POLL_MS = 40
const QUOTE = 0x22
const COMMA = 0x2c
const RETURN = 0x0d
const NEWLINE = 0x0a

/** The writer's state: still writing; done, with every row complete; or stopped, with the last row
 *  possibly truncated. A file opened directly has no writer and is done. */
export type Writer = 'writing' | 'done' | 'stopped'

/** The end piece carries the final stamp unless the file grew past what was read. */
export type Piece =
  | { readonly kind: 'header'; readonly bytes: Uint8Array; readonly stamp: Stamp }
  | { readonly kind: 'segment'; readonly bytes: Uint8Array }
  | { readonly kind: 'end'; readonly stamp?: Stamp }

/** Yields the file at `path` as it is written, until `writer` stops and nothing remains. A file
 *  matching `last`, left by a previous run, is ignored until rewritten. */
export async function* follow(
  path: string,
  signal: AbortSignal,
  writer: () => Writer,
  last?: Stamp,
  resume?: { readonly offset: number; readonly stamp: Stamp },
): AsyncGenerator<Piece> {
  let file: FileHandle | undefined
  let opened!: Stamp
  while (!file) {
    signal.throwIfAborted()
    // Checked before opening: a writer that is done by then has created its file if it ever will.
    const over = writer() !== 'writing'
    try {
      const found = await open(path, 'r')
      try {
        opened = stampOf(await found.stat({ bigint: true }))
        if (same(opened, last))
          throw Object.assign(new Error(`${basename(path)} is still the previous run's output.`), {
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
    /** Bytes read but not yet yielded are `buffer[from..to)`. */
    let buffer = new Uint8Array(2 * SEGMENT_BYTES)
    let from = 0
    let to = 0
    if (resume && (opened.file !== resume.stamp.file || opened.size < resume.offset))
      throw problem(
        'results-lost',
        `${basename(path)} changed while GridKit Studio was reading it.`,
      )
    let at = resume?.offset ?? 0
    let header = !!resume
    /** Where the search for the end of the header or of a segment resumes. */
    let scan = 0
    let quoted = false
    /** Whether the byte before `scan` closed a quoted name. */
    let closing = false
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
      // Checked before reading: a writer done by then has written everything this read sees.
      const state = writer()
      // Make room for a segment by compacting or growing the buffer.
      if (buffer.length - to < SEGMENT_BYTES) {
        const unread = to - from
        const next =
          unread + SEGMENT_BYTES > buffer.length
            ? new Uint8Array(2 * (unread + SEGMENT_BYTES))
            : buffer
        next.set(buffer.subarray(from, to), 0)
        scan -= from
        buffer = next
        from = 0
        to = unread
      }
      const room = buffer.length - to
      const { bytesRead } = await file.read(buffer, to, room, at)
      at += bytesRead
      to += bytesRead
      const finished = state !== 'writing' && bytesRead === 0
      // Only the header has quoted names. After it, a row ends at its newline.
      for (; !header && scan < to; scan++) {
        const byte = buffer[scan]!
        if (closing && byte !== QUOTE && byte !== COMMA && byte !== RETURN && byte !== NEWLINE)
          throw problem('io', 'The CSV header has an invalid quoted name.')
        closing = false
        if (byte === QUOTE) {
          quoted = !quoted
          closing = !quoted
        }
        if (byte !== NEWLINE || quoted) continue
        header = true
        // The header outlives this buffer.
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
        // When the writer is done, everything left is a segment; when it stopped, only whole rows.
        // While writing, whole rows are cut every PROGRESS_MS.
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
      // A short read caught up with the writer. The file only grows, so one that shrank or was
      // replaced is an error.
      if (bytesRead < room && state === 'writing') {
        const [now, there] = await Promise.all([
          file.stat({ bigint: true }),
          stampAt(path).catch(() => undefined),
        ])
        if (Number(now.size) < at || (there && there.file !== opened.file))
          throw problem(
            'io',
            `${basename(path)} was written over while GridKit Studio was reading it.`,
          )
        await setTimeout(POLL_MS, undefined, { signal })
      }
    }
  } finally {
    await file.close()
  }
}
