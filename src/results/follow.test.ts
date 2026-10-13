import { appendFile, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { follow, type Piece, type Writer } from './follow.js'
import { SEGMENT_BYTES } from './limits.js'
import { same, type Stamp, stampAt } from './stamp.js'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gridkit-follow-'))
})
afterAll(() => rm(directory, { recursive: true, force: true }))

const signal = new AbortController().signal
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')

/** Every piece of the file at `path`, followed until its `writer` is no longer writing, each as it
 *  came. */
async function pieces(
  path: string,
  writer: () => Writer = () => 'done',
  each?: () => unknown,
  last?: Stamp,
) {
  const all: Piece[] = []
  for await (const piece of follow(path, signal, writer, last)) {
    // A piece holds the bytes only until the next is read.
    all.push(piece.kind === 'end' ? piece : { ...piece, bytes: Uint8Array.from(piece.bytes) })
    await each?.()
  }
  return all
}

/** The text of every segment of `all`, in order. */
const segments = (all: readonly Piece[]) =>
  all.flatMap((piece) => (piece.kind === 'segment' ? [text(piece.bytes)] : []))

describe('a results file followed as it is written', () => {
  it('gives its header, then whole rows in segments that tile the rest, then its size', async () => {
    const path = join(directory, 'whole.csv')
    const header = 'time,"Bus one, Vm"\n'
    const rows = Array.from({ length: 1_000_000 }, (_, i) => `${i},${i % 7}\n`).join('')
    await writeFile(path, header + rows)
    const all = await pieces(path)
    const [first] = all
    // The header is read alone, a quoted comma and all.
    expect(first?.kind).toBe('header')
    expect(first?.kind === 'header' && text(first.bytes)).toBe(header)
    const read = segments(all)
    expect(read.length).toBeGreaterThan(1)
    for (const segment of read) {
      expect(segment.endsWith('\n')).toBe(true)
      // A segment ends at the first row end past its size, so none is much larger.
      expect(segment.length).toBeLessThan(SEGMENT_BYTES + 64)
    }
    expect(read.join('')).toBe(rows)
    // Read to its end with nothing written since, the file says which it was and how large.
    expect(all.at(-1)).toEqual({
      kind: 'end',
      stamp: {
        ...(first?.kind === 'header' && first.stamp),
        size: Buffer.byteLength(header + rows),
      },
    })
  })

  it('waits for the end of a row the writer is partway through', async () => {
    const path = join(directory, 'growing.csv')
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n0.01,1.')
    let writer: Writer = 'writing'
    let appended = false
    const all = await pieces(
      path,
      () => writer,
      async () => {
        if (appended) return
        appended = true
        await appendFile(path, '5\n0.02,1.25\n')
        writer = 'done'
      },
    )
    const rows = segments(all)
    expect(rows.join('')).toBe('0,1\n0.01,1.5\n0.02,1.25\n')
    expect(rows.every((segment) => segment.endsWith('\n'))).toBe(true)
  })

  it('keeps a last row without a newline only from a writer that finished', async () => {
    const path = join(directory, 'last.csv')
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n0.01,1.25')
    expect(segments(await pieces(path, () => 'done')).join('')).toBe('0,1\n0.01,1.25')
    // A writer stopped partway leaves a value cut short, which reads as a number of its own.
    expect(segments(await pieces(path, () => 'stopped')).join('')).toBe('0,1\n')
  })

  it('reads a header far larger than one read, every byte of it once', async () => {
    const path = join(directory, 'wide.csv')
    const names = Array.from({ length: 300_000 }, (_, i) => `"Bus_${i}_Vm"`)
    const header = `time,${names.join(',')}\n`
    await writeFile(path, header + '0,' + names.map(() => '1').join(',') + '\n')
    const [first, ...rest] = await pieces(path)
    expect(first?.kind === 'header' && first.bytes.length).toBe(Buffer.byteLength(header))
    expect(segments(rest)).toHaveLength(1)
  })

  it('says at once that a header quotes a name wrongly', async () => {
    const path = join(directory, 'quoted.csv')
    await writeFile(path, 'time,"Bus_A_Vm"x\n0,1\n')
    await expect(pieces(path)).rejects.toThrow('The CSV header has an invalid quoted name.')
  })

  it('says a finished file without a header has none', async () => {
    const path = join(directory, 'empty.csv')
    await writeFile(path, '')
    await expect(pieces(path)).rejects.toThrow('Results contain no header.')
  })

  it('waits for a file the writer has yet to make, and fails once it is done without one', async () => {
    const path = join(directory, 'later.csv')
    let writer: Writer = 'writing'
    const reading = pieces(path, () => writer)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n')
    writer = 'done'
    const all = await reading
    expect(all.map(({ kind }) => kind)).toEqual(['header', 'segment', 'end'])
    await expect(pieces(join(directory, 'never.csv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never reads what the last run left, and reads it once the writer writes over it', async () => {
    const path = join(directory, 'again.csv')
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n')
    const last = await stampAt(path)
    // A writer done without writing leaves the last run's file, which is no file of its own.
    await expect(pieces(path, () => 'done', undefined, last)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    let writer: Writer = 'writing'
    const reading = pieces(path, () => writer, undefined, last)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Written over in place, as GridKit opens its output, the file is the writer's.
    await writeFile(path, 'time,Bus_A_Vm\n0,2\n')
    writer = 'done'
    expect(segments(await reading)).toEqual(['0,2\n'])
  })
})

describe("a results file's stamp", () => {
  it('tells a file written again from the one read, whatever its size and time say', async () => {
    const path = join(directory, 'stamped.csv')
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n')
    const read = await stampAt(path)
    expect(same(read, await stampAt(path))).toBe(true)
    // As long, with its time set back as `cp -p` or a copy in Explorer sets it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const { mtime } = await stat(path)
    await writeFile(path, 'time,Bus_A_Vm\n0,2\n')
    await utimes(path, mtime, mtime)
    const now = await stampAt(path)
    expect(now?.size).toBe(read?.size)
    expect(same(read, now)).toBe(false)
    // Another file put in its place, as long.
    const other = join(directory, 'other.csv')
    await writeFile(other, 'time,Bus_A_Vm\n0,3\n')
    await rename(other, path)
    expect(same(now, await stampAt(path))).toBe(false)
    expect(await stampAt(join(directory, 'missing.csv'))).toBeUndefined()
  })
})
