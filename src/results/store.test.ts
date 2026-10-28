import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Stamp } from './stamp.js'
import { type Checkpoint, FORMAT, Stores } from './store.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridkit-stores-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

/** A file of `frames` frames as it stood once written at `modified`. */
const stamp = (frames: number, modified = 1): Stamp => ({
  file: '1:1',
  size: frames * 10,
  modified: String(modified),
  changed: String(modified),
})

/** What a store of `frames` frames of the file at `path`, read through, says it holds. */
const manifest = (path: string, frames: number, modified = 1): Checkpoint => ({
  path,
  stamp: stamp(frames, modified),
  read: frames * 10,
  fingerprint: 'case',
  header: ['time', 'Bus_A_Vm'],
  frames,
  chunk: 2,
  domain: [0, frames - 1],
  domains: {},
  complete: true,
  reducers: [],
})

/** A store of the file at `path` read through: `frames` frames of two rows, two to a chunk. */
async function stored(stores: Stores, path: string, frames: number, modified = 1) {
  const store = await stores.create(path)
  store.shape([2], 2)
  for (let k = 0; k * 2 < frames; k++) {
    const count = Math.min(2, frames - k * 2)
    // Frame by frame, each frame's two rows: row r of frame t is 100 t + r.
    const values = Float64Array.from(
      { length: 2 * count },
      (_, i) => 100 * (k * 2 + (i >> 1)) + (i & 1),
    )
    await store.writeRaw(
      k * 2,
      Float64Array.from({ length: count }, (_, i) => k * 2 + i),
      [values],
    )
  }
  await store.writeCsv(new Uint8Array(frames * 10), 0)
  await store.checkpoint(manifest(path, frames, modified))
  return store
}

/** How many stores the window `owner` keeps, this one's unless said. */
const folders = async (owner = process.pid) =>
  (await readdir(join(root, FORMAT, String(owner))).catch(() => [])).length

/** The id of a process that has exited, as a window gone leaves its extension host's. */
async function exited(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

describe('the stores of the results files a worker reads', () => {
  it('reads back each row of a chunk as one run of its frames, and only the rows asked for', async () => {
    const stores = new Stores(root)
    const store = await stored(stores, join(root, 'a.csv'), 5)
    // Chunk 1 holds frames 2 and 3; row 0 then row 1, each its two frames.
    expect(Array.from((await store.readRaw(store.raw[1]!, 0)).values)).toEqual([200, 201, 300, 301])
    expect(Array.from((await store.readRaw(store.raw[1]!, 0, [1])).values)).toEqual([201, 301])
    expect(Array.from((await store.readRaw(store.raw[1]!, 0, [1, 0], 1, 1)).values)).toEqual([
      301, 300,
    ])
    expect(Array.from((await store.readRaw(store.raw[1]!, 0, [1, 1], 0, 2)).values)).toEqual([
      201, 201, 301, 301,
    ])
    // The last chunk, cut short with the file.
    expect(Array.from((await store.readRaw(store.raw[2]!, 0)).values)).toEqual([400, 401])
    expect(Array.from(await store.times(store.raw[1]!))).toEqual([2, 3])
    await stores.release(store)
  })

  it('finds a store read through only of the same file, as it was, against the same case', async () => {
    const stores = new Stores(root)
    const path = join(root, 'a.csv')
    const store = await stored(stores, path, 4)
    await stores.release(store)
    const now = stamp(4)
    expect(await stores.find(path, now, 'case')).toBe(store)
    // Written again, its time set back or not, or another file in its place.
    expect(await stores.find(path, { ...now, modified: '2' }, 'case')).toBeUndefined()
    expect(await stores.find(path, { ...now, changed: '2' }, 'case')).toBeUndefined()
    expect(await stores.find(path, { ...now, file: '1:2' }, 'case')).toBeUndefined()
    expect(await stores.find(path, now, 'another case')).toBeUndefined()
    expect(await stores.find(join(root, 'b.csv'), now, 'case')).toBeUndefined()
  })

  it('lets a store that does not read go, so its file is read again', async () => {
    const stores = new Stores(root)
    const path = join(root, 'a.csv')
    const store = await stored(stores, path, 4)
    await stores.release(store)
    const found = await stores.find(path, stamp(4), 'case')
    await stores.discard(found!)
    expect(await stores.find(path, stamp(4), 'case')).toBeUndefined()
    expect(await folders()).toBe(0)
  })

  it('keeps one store of a file, the latest, once nothing reads the one before', async () => {
    const stores = new Stores(root)
    const path = join(root, 'a.csv')
    const first = await stored(stores, path, 4)
    const second = await stored(stores, path, 6, 2)
    // The first is still read: it stays until let go of, then goes.
    expect(await folders()).toBe(2)
    await stores.release(first)
    expect(await folders()).toBe(1)
    await stores.release(second)
    expect(await folders()).toBe(1)
    // One never read through goes as it is let go of.
    await stores.release(await stores.create(path))
    expect(await folders()).toBe(1)
  })

  it('sweeps, as a worker starts, all but the latest store of each file a saved session names', async () => {
    const before = new Stores(root)
    const [a, b] = [join(root, 'a.csv'), join(root, 'b.csv')]
    for (const store of [
      await stored(before, a, 4, 1),
      await stored(before, a, 4, 2),
      await stored(before, b, 4),
    ])
      await store.close()
    // A store a window died writing says nothing of what it holds.
    await before.create(a)
    expect(await folders()).toBe(4)
    const after = new Stores(root)
    await after.sweep([a])
    expect(await folders()).toBe(1)
    expect((await after.find(a, stamp(4, 2), 'case'))?.manifest?.stamp.modified).toBe('2')
  })

  it('never sweeps away the stores of a window still open, and takes those of one gone', async () => {
    const [a, b] = [join(root, 'a.csv'), join(root, 'b.csv')]
    // Another window, still open, writes a store of a file this one's sessions never name.
    const open = process.ppid
    const writing = await new Stores(root, open).create(b)
    // A window gone left a store read through of a file this one's sessions name.
    const gone = await exited()
    await (await stored(new Stores(root, gone), a, 4)).close()
    // What is no window's folder is no store of Studio's now.
    await mkdir(join(root, FORMAT, 'stray'))
    const mine = new Stores(root)
    await mine.sweep([a])
    expect(await folders(open)).toBe(1)
    expect((await mine.find(a, stamp(4), 'case'))?.manifest?.frames).toBe(4)
    expect((await readdir(join(root, FORMAT))).sort()).toEqual(
      [String(open), String(process.pid)].sort(),
    )
    // The other window's store takes its frames still.
    writing.shape([2], 2)
    await writing.writeRaw(0, Float64Array.of(0, 1), [Float64Array.of(1, 2, 3, 4)])
    await writing.close()
  })
})
