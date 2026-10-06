import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { Case, catalog } from '../gridkit/index.js'
import type { SimulationInfo } from '../shared/simulation.js'
import { ResultStorage } from './storage.js'

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
