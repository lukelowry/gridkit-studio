import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Data } from 'latkit'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { bundle, type Rig, start } from '../../tests/rig.js'
import { FORMAT } from '../results/store.js'
import { PAGE_BYTES, type RecordedField } from '../shared/data.js'
import { type Results, type Revision, revisionOf } from '../shared/messages.js'
import { loadNative } from './native.js'

let script: string
beforeAll(async () => {
  script = await bundle('results')
  await loadNative(createRequire(import.meta.url).resolve('latkit/wasm'))
})

const ONE = '{"buses":[{"class":"Bus","number":1,"name":"one"}]}'

/** Writes case `name` and reads it at `version`, as the extension does. */
async function caseOf(rig: Rig, name: string, text = ONE, version = 1): Promise<Revision> {
  const path = join(rig.scratch, name + '.case.json')
  await writeFile(path, text)
  return revisionOf(await rig.call('read', { uri: pathToFileURL(path).href, version }))
}

const open = (rig: Rig, revision: Revision, path: string, signal?: AbortSignal): Promise<Results> =>
  rig.call('open', { ...revision, results: randomUUID(), path }, signal)

/** `results` updated with every progress event the worker has sent for them. */
function latest(rig: Rig, results: Results): Results {
  let now = results
  for (const event of rig.events)
    if (event.kind === 'results' && event.results === results.id)
      now = { ...now, ...event.layout, ...event.progress }
  return now
}

/** `results` once read to the end, as the worker last reported them. */
async function readToEnd(rig: Rig, results: Results): Promise<Results> {
  if (!results.growing) return results
  return vi.waitFor(
    () => {
      const now = latest(rig, results)
      if (now.growing) throw new Error(`${results.name} is still being read.`)
      return now
    },
    { timeout: 5000 },
  )
}

async function storeOf(folder: string): Promise<string> {
  const own = join(folder, 'store', FORMAT, String(process.pid))
  const [store] = await readdir(own)
  return join(own, store!)
}

/** A CSV file of `frames` frames of bus `one`'s voltage, each `value(i)` at time `i`. */
async function waveform(path: string, frames: number, value = (i: number) => String(i % 3)) {
  await writeFile(
    path,
    'time,Bus_one_Vm\n' + Array.from({ length: frames }, (_, i) => `${i},${value(i)}\n`).join(''),
  )
}

/** Enough wide frames for several segments, so an open resolves before the read ends. */
const SEVERAL = 120_000
const wide = () => '1.' + '0'.repeat(32)

/** The page a view gets for `field` over all of `results`. These files fit one page. */
async function allFrames(
  rig: Rig,
  results: Results,
  field: Pick<RecordedField, 'table' | 'field'>,
): Promise<Data> {
  const page = await rig.call('frames', {
    results: results.id,
    ...field,
    range: results.domain,
    step: 0,
  })
  expect(page.bytes.byteLength).toBeLessThanOrEqual(PAGE_BYTES)
  const data = new Data(page.source)
  data.apply(page.bytes)
  expect(data.describe().span).toEqual(results.domain)
  return data
}

describe("the worker's results", () => {
  it('answers once the first frames are read, and reads on to the end', async () => {
    const rig = await start(script)
    try {
      const path = join(rig.scratch, 'long.csv')
      const frames = SEVERAL
      await waveform(path, frames, wide)
      const opened = await open(rig, await caseOf(rig, 'long'), path)
      expect(opened.growing).toBe(true)
      expect(opened.frames).toBeGreaterThan(0)
      expect(opened.frames).toBeLessThan(frames)
      const results = await readToEnd(rig, opened)
      expect(results).toMatchObject({ growing: false, frames, domain: [0, frames - 1] })
      expect(results.error).toBeUndefined()
    } finally {
      await rig.stop()
    }
  })

  it('reports why a file stops reading partway, and keeps what it read', async () => {
    const rig = await start(script)
    try {
      // The last row, in a later segment, lacks the voltage.
      const path = join(rig.scratch, 'broken-late.csv')
      await waveform(path, SEVERAL, wide)
      await appendFile(path, `${SEVERAL}\n`)
      const results = await readToEnd(rig, await open(rig, await caseOf(rig, 'late'), path))
      expect(results.growing).toBe(false)
      expect(results.error).toMatch(/does not match its header/)
      expect(results.frames).toBeGreaterThan(0)
    } finally {
      await rig.stop()
    }
  })

  it('reads a results file where it is, against the case read at its revision, which it keeps as the case file changes', async () => {
    const rig = await start(script)
    try {
      const path = join(rig.scratch, 'small.csv')
      const csv = 'time,Bus_one_Vm\n0,1\n1,0.8\n2,1\n'
      await writeFile(path, csv)
      const source = await caseOf(rig, 'known')
      const first = await readToEnd(rig, await open(rig, source, path))
      expect(first).toMatchObject({ growing: false, path, frames: 3 })
      expect(first.outputs).toMatchObject([{ table: 'Bus', field: 'Vm', ids: [1] }])
      expect(first.domains).toEqual({ Bus: { Vm: [0.8, 1] } })
      const again = await open(rig, source, path)
      // The same file and case reopened share one loaded file.
      expect(await rig.call('stats', {})).toMatchObject({ cases: 1, results: 2, files: 1 })
      // Once the case file changes, the old revision is superseded.
      const two = ONE.replace(']}', ',{"class":"Bus","number":2,"name":"two"}]}')
      const changed = await caseOf(rig, 'known', two, 2)
      await expect(open(rig, source, path)).rejects.toMatchObject({ code: 'superseded' })
      // Results read against the old revision keep that case for their views.
      expect(await rig.call('describe', { results: first.id })).toMatchObject({
        ...source,
        fingerprint: first.fingerprint,
        counts: { Bus: 1 },
      })
      const fields = [{ table: 'Bus', fields: ['name'] }]
      const columns = await rig.call('caseRows', { results: first.id, fields })
      expect(columns.key.startsWith(first.fingerprint)).toBe(true)
      // Against the new revision, the same file is read again.
      const third = await open(rig, changed, path)
      expect(third.fingerprint).not.toBe(first.fingerprint)
      expect(await rig.call('describe', { results: third.id })).toMatchObject(changed)
      expect(await rig.call('stats', {})).toMatchObject({ cases: 1, results: 3, files: 2 })
      const exported = join(rig.scratch, 'exported.csv')
      await rig.call('export', { results: first.id, path: exported })
      expect(await readFile(exported, 'utf8')).toBe(csv)
      for (const { id } of [first, again, third]) await rig.call('close', { results: id })
      for (const asked of [
        rig.call('caseRows', { results: first.id, fields }),
        rig.call('export', { results: first.id, path: exported }),
      ])
        await expect(asked).rejects.toMatchObject({ code: 'results-closed' })
      expect(await readFile(path, 'utf8')).toBe(csv)
    } finally {
      await rig.stop()
    }
  })

  it('keeps nothing of an open cancelled before it resolves', async () => {
    const rig = await start(script)
    try {
      const large = join(rig.scratch, 'large.csv')
      await waveform(large, SEVERAL, wide)
      const small = join(rig.scratch, 'small.csv')
      await waveform(small, 3)
      const controller = new AbortController()
      const cancelled = open(rig, await caseOf(rig, 'cancelled'), large, controller.signal)
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
      // Requests are handled in order, so the cancelled open has settled by now.
      const kept = await readToEnd(rig, await open(rig, await caseOf(rig, 'cancelled'), small))
      expect(await rig.call('stats', {})).toMatchObject({ results: 1, files: 1, idle: 0 })
      expect(
        rig.events.every((event) => event.kind !== 'results' || event.results === kept.id),
      ).toBe(true)
    } finally {
      await rig.stop()
    }
  })

  it('serves what it read of a file rewritten since, and reads the new file when reopened', async () => {
    // No cache, so every read of the results goes to the store.
    const rig = await start(script, { options: { cacheBytes: 0 } })
    try {
      const path = join(rig.scratch, 'rewritten.csv')
      await waveform(path, 3, () => '1')
      const results = await readToEnd(rig, await open(rig, await caseOf(rig, 'rewritten'), path))
      await waveform(path, 3, () => '9')
      const later = new Date(Date.now() + 2000)
      await utimes(path, later, later)
      const values = async (of: Results) => {
        using data = await allFrames(rig, of, { table: 'Bus', field: 'Vm' })
        return [0, 1, 2].map((at) => data.get('Bus', 1, 'Vm', { at }))
      }
      expect(await values(results)).toEqual([1, 1, 1])
      expect(
        await values(await readToEnd(rig, await open(rig, await caseOf(rig, 'rewritten'), path))),
      ).toEqual([9, 9, 9])
    } finally {
      await rig.stop()
    }
  })

  it('shares one file across several ids, as an export shares a view’s, and caches it once all close', async () => {
    const rig = await start(script)
    try {
      const path = join(rig.scratch, 'shared.csv')
      await waveform(path, 3)
      const source = await caseOf(rig, 'shared')
      const shown = await readToEnd(rig, await open(rig, source, path))
      const exported = await rig.call('share', { results: shown.id, as: randomUUID() })
      expect(exported).toMatchObject({ frames: 3, path })
      await rig.call('close', { results: shown.id })
      using shared = await allFrames(rig, exported, { table: 'Bus', field: 'Vm' })
      expect(shared.get('Bus', 1, 'Vm', { at: 2 })).toBe(2)
      expect(await rig.call('stats', {})).toMatchObject({ results: 1, files: 1, idle: 0 })
      await rig.call('close', { results: exported.id })
      expect(await rig.call('stats', {})).toMatchObject({ results: 0, files: 0, idle: 1 })
      // Reopened, it comes from the cache without reading again.
      const again = await open(rig, source, path)
      expect(again).toMatchObject({ growing: false, frames: 3 })
      expect(await rig.call('stats', {})).toMatchObject({ results: 1, files: 1, idle: 0 })
    } finally {
      await rig.stop()
    }
  })

  it('reads the same file again in a fresh worker, as a reload does', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gridkit-reload-'))
    const csv = join(folder, 'results.csv')
    await writeFile(csv, 'time,Bus_one_Vm\n0,1\n1,0.8\n2,1\n')
    let rig = await start(script, { folder })
    try {
      const first = await readToEnd(rig, await open(rig, await caseOf(rig, 'reloaded'), csv))
      const exported = join(folder, 'exported.csv')
      await rig.call('export', { results: first.id, path: exported })
      const measured = await readFile(exported, 'utf8')
      await rig.stop()
      // A saved session names the file, so its store is kept and read without the CSV.
      rig = await start(script, { folder, options: { saved: [csv] } })
      const again = await open(rig, await caseOf(rig, 'reloaded'), csv)
      expect(again.growing).toBe(false)
      expect(again).toMatchObject({
        frames: first.frames,
        domain: first.domain,
        domains: first.domains,
        outputs: first.outputs,
      })
      await rig.call('export', { results: again.id, path: exported })
      expect(await readFile(exported, 'utf8')).toEqual(measured)
      expect(await rig.call('step', { results: again.id, at: 0, direction: 1 })).toBe(1)
    } finally {
      await rig.stop()
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('reads a file from its CSV again when its store was truncated', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gridkit-cut-'))
    const csv = join(folder, 'results.csv')
    await waveform(csv, 40)
    let rig = await start(script, { folder })
    try {
      const first = await readToEnd(rig, await open(rig, await caseOf(rig, 'cut'), csv))
      using a = await allFrames(rig, first, { table: 'Bus', field: 'Vm' })
      await rig.stop()
      await truncate(join(await storeOf(folder), 'raw.bin'), 8)
      rig = await start(script, { folder, options: { saved: [csv] } })
      const again = await readToEnd(rig, await open(rig, await caseOf(rig, 'cut'), csv))
      expect(again.frames).toBe(first.frames)
      using b = await allFrames(rig, again, { table: 'Bus', field: 'Vm' })
      expect([0, 20, 39].map((at) => b.get('Bus', 1, 'Vm', { at }))).toEqual(
        [0, 20, 39].map((at) => a.get('Bus', 1, 'Vm', { at })),
      )
    } finally {
      await rig.stop()
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('reads a file again in full once it changed in place under an unfinished read', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gridkit-rewritten-'))
    const csv = join(folder, 'results.csv')
    await waveform(csv, 40)
    let rig = await start(script, { folder })
    try {
      const first = await readToEnd(rig, await open(rig, await caseOf(rig, 'rewritten'), csv))
      await rig.stop()
      // A partial store, then the file overwritten in place with the same size.
      const manifest = join(await storeOf(folder), 'manifest.json')
      const kept = JSON.parse(await readFile(manifest, 'utf8')) as object
      await writeFile(manifest, JSON.stringify({ ...kept, complete: false }))
      await waveform(csv, 40, (i) => String((i + 1) % 3))
      rig = await start(script, { folder, options: { saved: [csv] } })
      const again = await readToEnd(rig, await open(rig, await caseOf(rig, 'rewritten'), csv))
      expect(again.frames).toBe(first.frames)
      using data = await allFrames(rig, again, { table: 'Bus', field: 'Vm' })
      expect([0, 20, 39].map((at) => data.get('Bus', 1, 'Vm', { at }))).toEqual(
        [0, 20, 39].map((at) => (at + 1) % 3),
      )
    } finally {
      await rig.stop()
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('drops results whose store is damaged, and reports them lost', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gridkit-lost-'))
    const csv = join(folder, 'results.csv')
    await waveform(csv, 40)
    const rig = await start(script, { folder, options: { cacheBytes: 0 } })
    try {
      const source = await caseOf(rig, 'lost')
      const results = await readToEnd(rig, await open(rig, source, csv))
      await truncate(join(await storeOf(folder), 'raw.bin'), 0)
      await expect(allFrames(rig, results, { table: 'Bus', field: 'Vm' })).rejects.toMatchObject({
        code: 'results-lost',
      })
      expect(rig.events).toContainEqual({
        kind: 'lost',
        uri: source.uri,
        results: results.id,
      })
      await expect(
        rig.call('step', { results: results.id, at: 0, direction: 1 }),
      ).rejects.toMatchObject({ code: 'results-closed' })
    } finally {
      await rig.stop()
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('keeps what the extension has open, for any number of cases, and nothing once it closes them', async () => {
    const rig = await start(script)
    try {
      const path = join(rig.scratch, 'shared.csv')
      await waveform(path, 3)
      const opened = await Promise.all(
        Array.from({ length: 20 }, async (_, n) =>
          readToEnd(rig, await open(rig, await caseOf(rig, `case-${n}`), path)),
        ),
      )
      expect(await rig.call('stats', {})).toMatchObject({ results: 20, files: 20, cases: 20 })
      // Each was read to the end, so closing stops nothing.
      for (const { id } of opened) await rig.call('close', { results: id })
      // Closed files stay cached under the budget until the budget drops.
      expect(await rig.call('stats', {})).toMatchObject({ results: 0, files: 0, idle: 20 })
      await rig.call('configure', { cacheBytes: 0 })
      expect(await rig.call('stats', {})).toMatchObject({
        results: 0,
        idle: 0,
        runs: 0,
        cacheBytes: 0,
      })
      await rig.call('close', { results: opened[0]!.id })
    } finally {
      await rig.stop()
    }
  })

  it('keeps nothing of a file whose first frames fail to read', async () => {
    const rig = await start(script)
    try {
      const revision = await caseOf(rig, 'unread')
      const path = join(rig.scratch, 'whole.csv')
      await waveform(path, 3)
      await readToEnd(rig, await open(rig, revision, path))
      const broken = join(rig.scratch, 'broken.csv')
      await writeFile(broken, 'time,Bus_one_Vm\n0,1\n0.01\n')
      await expect(open(rig, revision, broken)).rejects.toThrow(/does not match its header/)
      expect(await rig.call('stats', {})).toMatchObject({ results: 1, files: 1, idle: 0 })
    } finally {
      await rig.stop()
    }
  })
})
