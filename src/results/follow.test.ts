import {
  appendFile,
  mkdtemp,
  rename,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { follow, type Piece, POLL_MS, type Writer } from './follow.js'
import { SEGMENT_BYTES } from './limits.js'
import { same, type Stamp, stampAt } from './stamp.js'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gridkit-follow-'))
})
afterAll(() => rm(directory, { recursive: true, force: true }))

const signal = new AbortController().signal
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')

/** Every piece of the file at `path`, followed until `writer` stops, in order. */
async function pieces(
  path: string,
  writer: () => Writer = () => 'done',
  each?: () => unknown,
  last?: Stamp,
) {
  const all: Piece[] = []
  for await (const piece of follow(path, signal, writer, last)) {
    // A piece's bytes are valid only until the next read, so copy them.
    all.push(piece.kind === 'end' ? piece : { ...piece, bytes: Uint8Array.from(piece.bytes) })
    await each?.()
  }
  return all
}

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
    // The header is yielded alone, including a quoted comma.
    expect(first?.kind).toBe('header')
    expect(first?.kind === 'header' && text(first.bytes)).toBe(header)
    const read = segments(all)
    expect(read.length).toBeGreaterThan(1)
    for (const segment of read) {
      expect(segment.endsWith('\n')).toBe(true)
      // A segment ends at the first row end past its target size, so none is much larger.
      expect(segment.length).toBeLessThan(SEGMENT_BYTES + 64)
    }
    expect(read.join('')).toBe(rows)
    // Read to the end with nothing written since, the end piece carries the file's stamp.
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
    // A stopped writer may leave a truncated value that still parses as a number, so it is dropped.
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

  it('reports a wrongly quoted header name at once', async () => {
    const path = join(directory, 'quoted.csv')
    await writeFile(path, 'time,"Bus_A_Vm"x\n0,1\n')
    await expect(pieces(path)).rejects.toThrow('The CSV header has an invalid quoted name.')
  })

  it('reports a finished file that has no header', async () => {
    const path = join(directory, 'empty.csv')
    await writeFile(path, '')
    await expect(pieces(path)).rejects.toThrow('Results contain no header.')
  })

  it('waits for a file the writer has yet to make, and fails once it is done without one', async () => {
    const path = join(directory, 'later.csv')
    let writer: Writer = 'writing'
    const reading = pieces(path, () => writer)
    await new Promise((resolve) => setTimeout(resolve, 3 * POLL_MS))
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n')
    writer = 'done'
    const all = await reading
    expect(all.map(({ kind }) => kind)).toEqual(['header', 'segment', 'end'])
    await expect(pieces(join(directory, 'never.csv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails once the followed file is truncated or replaced', async () => {
    const header = 'time,Bus_A_Vm\n'
    const overwrites = [(path: string) => truncate(path, header.length)]
    // Windows does not allow replacing a file open for reading.
    if (process.platform !== 'win32')
      overwrites.push(async (path: string) => {
        const other = path + '.other'
        await writeFile(other, header + '0,9\n0.01,9\n0.02,9\n')
        await rename(other, path)
      })
    for (const overwrite of overwrites) {
      const path = join(directory, 'overwritten.csv')
      await writeFile(path, header + '0,1\n0.01,1.25\n')
      let first = true
      const reading = pieces(
        path,
        () => 'writing',
        async () => {
          if (!first) return
          first = false
          await overwrite(path)
        },
      )
      await expect(reading).rejects.toThrow('written over')
    }
  })

  it('never reads what the last run left, and reads it once the writer writes over it', async () => {
    const path = join(directory, 'again.csv')
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n')
    const last = await stampAt(path)
    // A writer that finishes without writing leaves the previous run's file, which is not its own.
    await expect(pieces(path, () => 'done', undefined, last)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    let writer: Writer = 'writing'
    const reading = pieces(path, () => writer, undefined, last)
    await new Promise((resolve) => setTimeout(resolve, 3 * POLL_MS))
    // Once overwritten in place, as GridKit opens its output, the file is the writer's.
    await writeFile(path, 'time,Bus_A_Vm\n0,2\n')
    writer = 'done'
    expect(segments(await reading)).toEqual(['0,2\n'])
  })
})

describe("a results file's stamp", () => {
  it('detects a rewritten file, whatever its size and time', async () => {
    const path = join(directory, 'stamped.csv')
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n')
    const read = await stampAt(path)
    expect(same(read, await stampAt(path))).toBe(true)
    // Same length, with its modified time set back as `cp -p` or an Explorer copy does.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const { mtime } = await stat(path)
    await writeFile(path, 'time,Bus_A_Vm\n0,2\n')
    await utimes(path, mtime, mtime)
    const now = await stampAt(path)
    expect(now?.size).toBe(read?.size)
    expect(same(read, now)).toBe(false)
    // Another file of the same length moved into its place.
    const other = join(directory, 'other.csv')
    await writeFile(other, 'time,Bus_A_Vm\n0,3\n')
    await rename(other, path)
    expect(same(now, await stampAt(path))).toBe(false)
    expect(await stampAt(join(directory, 'missing.csv'))).toBeUndefined()
  })
})
