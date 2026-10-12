import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { follow, type Piece } from './follow.js'
import { SEGMENT_BYTES } from './limits.js'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gridkit-follow-'))
})
afterAll(() => rm(directory, { recursive: true, force: true }))

const signal = new AbortController().signal
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')

/** Every piece of the file at `path`, followed until `ended`, each as it came. */
async function pieces(path: string, ended: () => boolean = () => true, each?: () => unknown) {
  const all: Piece[] = []
  for await (const piece of follow(path, signal, ended)) {
    all.push({ ...piece, bytes: piece.bytes.slice() })
    await each?.()
  }
  return all
}

describe('a results file followed as it is written', () => {
  it('gives its header, then whole rows in segments that tile the rest', async () => {
    const path = join(directory, 'whole.csv')
    const header = 'time,"Bus one, Vm"\n'
    const rows = Array.from({ length: 1_000_000 }, (_, i) => `${i},${i % 7}\n`).join('')
    await writeFile(path, header + rows)
    const [first, ...segments] = await pieces(path)
    // The header is read alone, a quoted comma and all.
    expect(first).toEqual({ kind: 'header', bytes: expect.anything() })
    expect(text(first!.bytes)).toBe(header)
    expect(segments.length).toBeGreaterThan(1)
    let at = Buffer.byteLength(header)
    for (const segment of segments) {
      if (segment.kind !== 'segment') throw new Error('a second header')
      expect(segment.start).toBe(at)
      expect(segment.end - segment.start).toBe(segment.bytes.length)
      expect(segment.bytes.at(-1)).toBe(10)
      // A segment ends at the first row end past its size, so none is much larger.
      expect(segment.bytes.length).toBeLessThan(SEGMENT_BYTES + 64)
      at = segment.end
    }
    expect(segments.map(({ bytes }) => text(bytes)).join('')).toBe(rows)
  })

  it('waits for the end of a row the writer is partway through', async () => {
    const path = join(directory, 'growing.csv')
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n0.01,1.')
    let done = false
    let appended = false
    const all = await pieces(
      path,
      () => done,
      async () => {
        if (appended) return
        appended = true
        await appendFile(path, '5\n0.02,1.25\n')
        done = true
      },
    )
    const rows = all.filter((piece) => piece.kind === 'segment').map(({ bytes }) => text(bytes))
    expect(rows.join('')).toBe('0,1\n0.01,1.5\n0.02,1.25\n')
    expect(rows.every((segment) => segment.endsWith('\n'))).toBe(true)
  })

  it('keeps its header apart from the read it came in', async () => {
    const path = join(directory, 'header.csv')
    const header = 'time,Bus_A_Vm\n'
    await writeFile(path, header + '0,1\n')
    for await (const piece of follow(path, signal, () => true))
      if (piece.kind === 'header') expect(piece.bytes.buffer.byteLength).toBe(header.length)
  })

  it('says a finished file without a header has none', async () => {
    const path = join(directory, 'empty.csv')
    await writeFile(path, '')
    await expect(pieces(path)).rejects.toThrow('Results contain no header.')
  })

  it('waits for a file the writer has yet to make, and fails once it is done without one', async () => {
    const path = join(directory, 'later.csv')
    let ended = false
    const reading = pieces(path, () => ended)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(path, 'time,Bus_A_Vm\n0,1\n')
    ended = true
    const all = await reading
    expect(all.map(({ kind }) => kind)).toEqual(['header', 'segment'])
    await expect(pieces(join(directory, 'never.csv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
