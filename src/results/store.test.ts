import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { VisualizationRun } from './frames.js'
import type { Stamp } from './stamp.js'
import { type Checkpoint, FORMAT, Stores } from './store.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gridkit-stores-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const stamp = (frames: number, modified = 1): Stamp => ({
  file: '1:1',
  size: frames * 10,
  modified: String(modified),
  changed: String(modified),
})

const manifest = (path: string, frames: number, modified = 1, complete = true): Checkpoint => ({
  path,
  stamp: stamp(frames, modified),
  read: frames * 10,
  fingerprint: 'case',
  header: ['time', 'Bus_A_Vm'],
  frames,
  domain: [0, frames - 1],
  domains: {},
  complete,
  reducers: [],
})

/** A committed store of `frames` frames of two rows, two frames per block. */
async function stored(stores: Stores, path: string, frames: number, modified = 1, complete = true) {
  const store = await stores.create(path)
  store.shape([2])
  for (let k = 0; k * 2 < frames; k++) {
    const count = Math.min(2, frames - k * 2)
    // Frame-major: row r of frame t is 100 t + r.
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
  await store.checkpoint(manifest(path, frames, modified, complete))
  return store
}

const folders = async (owner = process.pid) =>
  (await readdir(join(root, FORMAT, String(owner))).catch(() => [])).length

/** The pid of a process that has exited, like a closed window's extension host. */
async function exited(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

describe('the stores of the results files a worker reads', () => {
  it('reads back each row of a block as one run of its frames, and only the rows asked for', async () => {
    const stores = new Stores(root)
    const store = await stored(stores, join(root, 'a.csv'), 5)
    // Block 1 has frames 2 and 3: row 0's two frames, then row 1's.
    expect(Array.from((await store.readRaw(store.raw[1]!, 0, [0, 1])).values)).toEqual([
      200, 201, 300, 301,
    ])
    expect(Array.from((await store.readRaw(store.raw[1]!, 0, [1])).values)).toEqual([201, 301])
    expect(Array.from((await store.readRaw(store.raw[1]!, 0, [1, 0], 1, 1)).values)).toEqual([
      301, 300,
    ])
    expect(Array.from((await store.readRaw(store.raw[1]!, 0, [1, 1], 0, 2)).values)).toEqual([
      201, 201, 301, 301,
    ])
    expect(Array.from((await store.readRaw(store.raw[2]!, 0, [0, 1])).values)).toEqual([400, 401])
    expect(Array.from(await store.times(store.raw[1]!))).toEqual([2, 3])
    await stores.release(store)
  })

  it('reads back the rows asked for of a block of buckets, as a read of every row gives them', async () => {
    const stores = new Stores(root)
    const store = await stores.create(join(root, 'a.csv'))
    const [rows, buckets] = [5, 4]
    store.shape([rows])
    // Bucket b of row r ranges from 10 b + r to 10 b + r + 0.5, over frames 8 b to 8 b + 7.
    const runs = Array.from({ length: buckets }, (_, b): VisualizationRun => ({
      level: 1,
      first: b,
      at: Float64Array.of(8 * b, 8 * b + 7),
      values: Float32Array.from(
        { length: 2 * rows },
        (_, i) => 10 * b + (i % rows) + (i < rows ? 0 : 0.5),
      ),
    }))
    await store.writeLevel(0, 1, runs)
    const [block] = store.levels.get('0:1')!
    const every = await store.readLevel(block!, [0, 1, 2, 3, 4])
    // Every bucket's minimums in order, then every bucket's maximums.
    expect(Array.from(every.values)).toEqual(
      [0, 0.5].flatMap((more) =>
        runs.flatMap((_, b) => [0, 1, 2, 3, 4].map((r) => 10 * b + r + more)),
      ),
    )
    for (const places of [[3], [4, 0], [1, 2, 3], [2, 2]])
      for (const [offset, count] of [
        [0, buckets],
        [1, 2],
        [3, 1],
      ] as const) {
        const some = await store.readLevel(block!, places, offset, count)
        expect(some.first).toBe(offset)
        expect(Array.from(some.at)).toEqual(
          Array.from(every.at.subarray(2 * offset, 2 * (offset + count))),
        )
        const plane = (from: number) =>
          Array.from({ length: count }, (_, t) =>
            places.map((place) => every.values[(from + offset + t) * rows + place]!),
          ).flat()
        expect(Array.from(some.values)).toEqual([...plane(0), ...plane(buckets)])
      }
    await stores.release(store)
  })

  it('restores its last checkpoint when reopened, whatever a read wrote after it', async () => {
    const stores = new Stores(root)
    const path = join(root, 'a.csv')
    const store = await stored(stores, path, 4, 1, false)
    await stores.release(store)
    // A read resumes it and writes another block, then closes without a checkpoint.
    const read = await stores.find(path, stamp(4), 'case')
    await read!.restore()
    await read!.writeRaw(4, Float64Array.of(4, 5), [Float64Array.of(400, 401, 500, 501)])
    expect(read!.raw).toHaveLength(3)
    await stores.release(read!)
    // The next read finds the checkpointed state and appends its frames after it.
    const again = await stores.find(path, stamp(4), 'case')
    await again!.restore()
    expect(again!.raw).toHaveLength(2)
    await again!.writeRaw(4, Float64Array.of(4), [Float64Array.of(900, 901)])
    expect(Array.from((await again!.readRaw(again!.raw[2]!, 0, [0, 1])).values)).toEqual([900, 901])
    await stores.release(again!)
  })

  it('finds a complete store only for the same, unchanged file and the same case', async () => {
    const stores = new Stores(root)
    const path = join(root, 'a.csv')
    const store = await stored(stores, path, 4)
    await stores.release(store)
    const now = stamp(4)
    expect(await stores.find(path, now, 'case')).toBe(store)
    // Rewritten, with or without its time set back, or replaced by another file.
    expect(await stores.find(path, { ...now, modified: '2' }, 'case')).toBeUndefined()
    expect(await stores.find(path, { ...now, changed: '2' }, 'case')).toBeUndefined()
    expect(await stores.find(path, { ...now, file: '1:2' }, 'case')).toBeUndefined()
    expect(await stores.find(path, now, 'another case')).toBeUndefined()
    expect(await stores.find(join(root, 'b.csv'), now, 'case')).toBeUndefined()
  })

  it('gives a partial store to one reader at a time', async () => {
    const stores = new Stores(root)
    const path = join(root, 'a.csv')
    await stores.release(await stored(stores, path, 4, 1, false))
    // The file has grown since, so one reader resumes the read.
    const now = { ...stamp(6), modified: '2', changed: '2' }
    const reader = await stores.find(path, now, 'case')
    expect(reader?.manifest).toMatchObject({ frames: 4, complete: false })
    expect(await stores.find(path, now, 'case')).toBeUndefined()
    await stores.release(reader!)
    expect(await stores.find(path, now, 'case')).toBe(reader)
    await reader!.checkpoint(manifest(path, 6, 2))
    expect(await stores.find(path, now, 'case')).toBe(reader)
    await stores.release(reader!)
    await stores.release(reader!)
  })

  it('discards an unusable store, so its file is read again', async () => {
    const stores = new Stores(root)
    const path = join(root, 'a.csv')
    const store = await stored(stores, path, 4)
    await stores.release(store)
    const found = await stores.find(path, stamp(4), 'case')
    await stores.discard(found!)
    expect(await stores.find(path, stamp(4), 'case')).toBeUndefined()
    expect(await folders()).toBe(0)
  })

  it('keeps only the latest store of a file once nothing reads the earlier one', async () => {
    const stores = new Stores(root)
    const path = join(root, 'a.csv')
    const first = await stored(stores, path, 4)
    const second = await stored(stores, path, 6, 2)
    // The first is still in use, so it stays until released, then is removed.
    expect(await folders()).toBe(2)
    await stores.release(first)
    expect(await folders()).toBe(1)
    await stores.release(second)
    expect(await folders()).toBe(1)
    await stores.release(await stores.create(path))
    expect(await folders()).toBe(1)
  })

  it('sweeps all but the latest store of each file a saved session names when a worker starts', async () => {
    const before = new Stores(root)
    const [a, b] = [join(root, 'a.csv'), join(root, 'b.csv')]
    for (const store of [
      await stored(before, a, 4, 1),
      await stored(before, a, 4, 2),
      await stored(before, b, 4),
    ])
      await store.close()
    // A window that died while writing leaves a store without a manifest.
    await before.create(a)
    expect(await folders()).toBe(4)
    const after = new Stores(root)
    await after.sweep([a])
    expect(await folders()).toBe(1)
    expect((await after.find(a, stamp(4, 2), 'case'))?.manifest?.stamp.modified).toBe('2')
  })

  it('never sweeps the stores of a window still open, and adopts those of a closed one', async () => {
    const [a, b] = [join(root, 'a.csv'), join(root, 'b.csv')]
    // Another open window writes a store of a file this window's sessions never name.
    const open = process.ppid
    const writing = await new Stores(root, open).create(b)
    // A closed window left a complete store of a file this window's sessions name.
    const gone = await exited()
    await (await stored(new Stores(root, gone), a, 4)).close()
    // Folders that belong to no window, or to another format, are not current stores.
    await mkdir(join(root, FORMAT, 'stray'))
    await mkdir(join(root, 'other-format', String(gone)), { recursive: true })
    const mine = new Stores(root)
    await mine.sweep([a])
    expect(await folders(open)).toBe(1)
    expect((await mine.find(a, stamp(4), 'case'))?.manifest?.frames).toBe(4)
    expect(await readdir(root)).toEqual([FORMAT])
    expect((await readdir(join(root, FORMAT))).sort()).toEqual(
      [String(open), String(process.pid)].sort(),
    )
    writing.shape([2])
    await writing.writeRaw(0, Float64Array.of(0, 1), [Float64Array.of(1, 2, 3, 4)])
    await writing.close()
  })
})
