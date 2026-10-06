import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { Case, catalog } from '../gridkit/index.js'
import type { SimulationInfo } from '../shared/simulation.js'
import { ResultStorage } from './storage.js'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rm: vi.fn(fs.rm), stat: vi.fn(fs.stat), writeFile: vi.fn(fs.writeFile) }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gridkit-storage-'))
  const storage = new ResultStorage(directory)
  const kase = await Case.parse('{"buses":[{"class":"Bus","number":1}]}', catalog)
  let started = 0
  const create = async (state: SimulationInfo['state'] = 'complete') => {
    const id = randomUUID()
    const info: SimulationInfo = {
      id,
      revision: { uri: 'file:///case.case.json', version: 1 },
      fingerprint: kase.version,
      name: 'case',
      state,
      path: join(storage.path(id), 'results.csv'),
      format: 'csv',
      frames: 1,
      domain: [0, 0],
      started: ++started,
      outputs: [{ from: 'Bus', select: ['Vm'] }],
    }
    await storage.create(
      info,
      {
        ...info.revision,
        values: {},
        outputs: info.outputs,
        gridkit: { path: '', image: '', cli: '' },
        cacheBytes: 16 << 20,
      },
      kase,
    )
    await writeFile(info.path, 'time,Bus_1_Vm\n0,1\n')
    return info
  }
  return {
    directory,
    storage,
    kase,
    create,
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

it('retains the original source independently of solver staging and persists interrupted state', async () => {
  const f = await fixture()
  try {
    const info = await f.create('preparing')
    await writeFile(join(f.storage.path(info.id), 'case.json'), 'solver-modified case')
    const reloaded = new ResultStorage(f.directory)
    await reloaded.initialize()
    expect(await reloaded.source(info.id)).toBe(new TextDecoder().decode(f.kase.file))
    expect(reloaded.records.get(info.id)?.info.state).toBe('interrupted')
    expect(
      JSON.parse(await readFile(join(f.storage.path(info.id), 'manifest.json'), 'utf8')).info.state,
    ).toBe('interrupted')
    expect(await reloaded.available(info.id)).toBe(true)
  } finally {
    await f.close()
  }
})

it('bounds recordings and source snapshots while protecting active work, baselines and readers', async () => {
  const f = await fixture()
  try {
    const old = await f.create()
    const pinned = await f.create()
    pinned.retained = true
    const active = await f.create('running')
    const reading = await f.create()
    const newest = await f.create()
    await f.storage.evict(0, new Set([newest.id]), async (id) => id !== reading.id)
    expect(old.evicted).toBe(true)
    expect(await readdir(f.storage.path(old.id))).toEqual(['manifest.json'])
    for (const info of [pinned, active, reading, newest])
      expect(await f.storage.available(info.id)).toBe(true)
    pinned.retained = false
    active.state = 'complete'
    await f.storage.evict(0, new Set(), async () => true)
    const reloaded = new ResultStorage(f.directory)
    await reloaded.initialize()
    expect(reloaded.records.size).toBe(5)
    expect([...reloaded.records.values()].every((record) => record.info.evicted)).toBe(true)
    await expect(reloaded.source(old.id)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await f.close()
  }
})

it('rejects a retained manifest that points outside its simulation directory', async () => {
  const f = await fixture()
  try {
    const info = await f.create()
    const path = join(f.storage.path(info.id), 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.info.path = '../../outside.csv'
    await writeFile(path, JSON.stringify(manifest))
    const reloaded = new ResultStorage(f.directory)
    await reloaded.initialize()
    expect(reloaded.records.size).toBe(0)
    expect(() => reloaded.path('../outside')).toThrow(/Invalid simulation/)
  } finally {
    await f.close()
  }
})

it('retries a partially deleted recording even when the budget is no longer exceeded', async () => {
  const f = await fixture()
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  try {
    const info = await f.create()
    vi.mocked(rm).mockImplementation(async (...args) => {
      if (args[0] === info.path) throw Object.assign(new Error('File is busy'), { code: 'EBUSY' })
      return fs.rm(...args)
    })
    await expect(f.storage.evict(0, new Set(), async () => true)).rejects.toThrow(/retried/)
    const manifest = join(f.storage.path(info.id), 'manifest.json')
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toMatchObject({ cleanupPending: true })
    expect(await f.storage.available(info.id)).toBe(false)
    vi.mocked(rm).mockReset()
    await f.storage.evict(Number.MAX_SAFE_INTEGER, new Set(), async () => true)
    expect(await readdir(f.storage.path(info.id))).toEqual(['manifest.json'])
    expect(JSON.parse(await readFile(manifest, 'utf8')).cleanupPending).toBeUndefined()
  } finally {
    vi.mocked(rm).mockReset()
    await f.close()
  }
})

it('repairs legacy evicted files on startup and caches finalized recording sizes', async () => {
  const f = await fixture()
  try {
    const old = await f.create()
    const kept = await f.create()
    old.evicted = true
    await f.storage.save(old.id)
    const restored = new ResultStorage(f.directory)
    await restored.initialize()
    expect(await readdir(restored.path(old.id))).toEqual(['manifest.json'])
    await restored.evict(Number.MAX_SAFE_INTEGER, new Set(), async () => true)
    vi.mocked(stat).mockClear()
    await restored.evict(Number.MAX_SAFE_INTEGER, new Set(), async () => true)
    expect(stat).not.toHaveBeenCalled()
    expect(await restored.available(kept.id)).toBe(true)
  } finally {
    await f.close()
  }
})

it('rolls back failed creation without changing an existing recording', async () => {
  const f = await fixture()
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  try {
    const kept = await f.create()
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      if (String(args[0]).includes('catalog.json.')) throw new Error('Snapshot write failed')
      return fs.writeFile(...args)
    })
    await expect(f.create()).rejects.toThrow('Snapshot write failed')
    expect(await readdir(join(f.directory, 'simulations'))).toEqual([kept.id])
    expect(f.storage.records.size).toBe(1)
    expect(await f.storage.available(kept.id)).toBe(true)
  } finally {
    vi.mocked(writeFile).mockReset()
    await f.close()
  }
})
