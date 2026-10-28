import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Data } from 'latkit'
import { beforeAll, expect, it } from 'vitest'

import { Case } from '../src/gridkit/case.js'
import { catalog } from '../src/gridkit/definition.js'
import { ResultCache } from '../src/results/cache.js'
import { ResultsFile } from '../src/results/file.js'
import { Store, Stores } from '../src/results/store.js'
import { loadNative } from '../src/workers/native.js'

const signal = AbortSignal.any([])
const require = createRequire(import.meta.url)
beforeAll(() => loadNative(require.resolve('latkit/wasm')))

it('keeps sparse exact results, bounded native windows, recovery watermarks, and original CSV', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'studio-native-results-'))
  const stores = new Stores(join(folder, 'cache'))
  await stores.sweep([])
  const path = join(folder, 'raw.csv')
  const csv =
    'time,Bus_A_Vm\n' +
    Array.from(
      { length: 1024 },
      (_, i) => String(Math.floor(i / 2) ** 2) + ',' + (i === 0 ? Math.PI : i === 511 ? 10000 : i),
    ).join('\n')
  await writeFile(path, csv)
  const kase = await Case.parse(
    JSON.stringify({
      buses: [
        { number: 42, name: 'A', class: 'Bus' },
        { number: 99, name: 'B', class: 'Bus' },
      ],
    }),
    catalog,
  )
  const cache = new ResultCache(96 << 20)
  const store = await stores.create(path)
  const reading = { path, revision: { uri: 'file:///case', version: 1 } }
  const file = new ResultsFile(kase, cache, store, reading)
  let restored: ResultsFile | undefined
  let reopened: Store | undefined
  try {
    await file.ingest(
      signal,
      () => 'done',
      () => {},
    )
    expect(file.layout.outputs).toEqual([{ table: 'Bus', field: 'Vm', ids: [42] }])
    expect(
      await file.sample({ results: 'r', table: 'Bus', field: 'Vm', id: 42, at: 0 }, signal),
    ).toEqual({ at: 0, value: 1 })
    expect((await store.readRaw(store.raw[0]!, 0, [0], 0, 1)).values[0]).toBe(Math.PI)
    expect(await file.step(0, 1)).toBe(1)
    expect(await file.step(1, -1)).toBe(0)
    const request = {
      results: 'r',
      table: 'Bus',
      field: 'Vm',
      ids: [42],
      range: [0, 511 ** 2] as const,
      purpose: 'plot' as const,
      pixels: 32,
      bytes: 4096,
    }
    let next: string | undefined
    let data: Data | undefined
    let payload = 0
    try {
      do {
        const page = await file.frames({ ...request, next }, signal)
        data ??= new Data(page.source)
        data.apply(page.bytes)
        payload += page.bytes.byteLength
        next = page.next
      } while (next)
      expect(payload).toBeLessThan(4096)
      expect(
        data!.envelope({ table: 'Bus', field: 'Vm', range: [0, 511 ** 2], spans: 1 }).greatest[0],
      ).toBe(10000)
    } finally {
      data?.destroy()
    }
    const manifest = store.manifest!
    await store.close()
    await appendFile(join(store.folder, 'raw.bin'), new Uint8Array(100))
    await appendFile(join(store.folder, 'levels.bin'), new Uint8Array(100))
    reopened = new Store(store.folder, store.key, manifest)
    restored = await ResultsFile.stored(kase, cache, reopened, reading)
    expect(restored.progress.frames).toBe(1024)
    await writeFile(path, 'overwritten externally')
    const exported = join(folder, 'export.csv')
    await restored.exportCsv(exported)
    expect(await readFile(exported, 'utf8')).toBe(csv)
  } finally {
    await file.retire()
    await restored?.retire()
    await reopened?.close()
    await store.close()
    await rm(folder, { recursive: true, force: true })
  }
})

it('preserves NaN gaps and rejects float32 overflow only at visualization', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'studio-native-gap-'))
  const stores = new Stores(join(folder, 'cache'))
  await stores.sweep([])
  const path = join(folder, 'raw.csv')
  await writeFile(path, 'time,Bus_A_Vm\n0,1\n0.1,NaN\n10,5\n20,1e100\n')
  const kase = await Case.parse('{"buses":[{"class":"Bus","number":7,"name":"A"}]}', catalog)
  const store = await stores.create(path)
  const file = new ResultsFile(kase, new ResultCache(96 << 20), store, {
    path,
    revision: { uri: 'file:///case', version: 1 },
  })
  try {
    await file.ingest(
      signal,
      () => 'done',
      () => {},
    )
    expect(
      (await file.sample({ results: 'r', table: 'Bus', field: 'Vm', id: 7, at: 20 }, signal)).value,
    ).toBe(1e100)
    expect(
      (await file.sample({ results: 'r', table: 'Bus', field: 'Vm', id: 7, at: 0.1 }, signal))
        .value,
    ).toBeNull()
    await expect(
      file.frames(
        {
          results: 'r',
          table: 'Bus',
          field: 'Vm',
          range: [0, 20],
          purpose: 'plot',
          pixels: 100,
          bytes: 4096,
        },
        signal,
      ),
    ).rejects.toThrow('float32')
  } finally {
    await file.retire()
    await store.close()
    await rm(folder, { recursive: true, force: true })
  }
})

it('refines isolated gaps without expanding whole disk blocks into raw samples', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'studio-native-sparse-gap-'))
  const stores = new Stores(join(folder, 'cache'))
  await stores.sweep([])
  const path = join(folder, 'raw.csv')
  const count = 600_000
  const missing = 300_017
  const spike = 499_999
  await writeFile(
    path,
    'time,Bus_A_Vm\n' +
      Array.from(
        { length: count },
        (_, i) => `${i},${i === missing ? 'NaN' : i === spike ? 10000 : 1}\n`,
      ).join(''),
  )
  const kase = await Case.parse('{"buses":[{"class":"Bus","number":7,"name":"A"}]}', catalog)
  const store = await stores.create(path)
  const file = new ResultsFile(kase, new ResultCache(96 << 20), store, {
    path,
    revision: { uri: 'file:///case', version: 1 },
  })
  let data: Data | undefined
  try {
    await file.ingest(
      signal,
      () => 'done',
      () => {},
    )
    let next: string | undefined
    let payload = 0
    do {
      const page = await file.frames(
        {
          results: 'r',
          table: 'Bus',
          field: 'Vm',
          range: [0, count - 1],
          purpose: 'plot',
          pixels: 512,
          bytes: 32 << 10,
          next,
        },
        signal,
      )
      data ??= new Data(page.source)
      data.apply(page.bytes)
      payload += page.bytes.byteLength
      next = page.next
    } while (next)
    expect(payload).toBeLessThan(32 << 10)
    expect(data!.get('Bus', 7, 'Vm', { at: missing })).toBeNull()
    expect(
      data!.envelope({ table: 'Bus', field: 'Vm', range: [0, count - 1], spans: 1 }).greatest[0],
    ).toBe(10000)
    expect(store.levels.get('0:1')!.flatMap((block) => block.gapped)).toEqual([
      Math.floor(missing / 8),
    ])
  } finally {
    data?.destroy()
    await file.retire()
    await store.close()
    await rm(folder, { recursive: true, force: true })
  }
})
