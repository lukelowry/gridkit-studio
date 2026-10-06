import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

import type { FromWorker, Method, Requests } from './shared/messages.js'

const entry = resolve('output/tests/contract-worker.cjs')
beforeAll(async () => {
  await build({
    entryPoints: ['src/worker.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    mainFields: ['module', 'main'],
  })
})
/** A worker on a scratch directory of its own, every batch it sends kept. A batch is acknowledged
 *  as it arrives only while `acknowledge` is on. */
async function start(storage?: string, fault?: 'copy' | 'cleanup') {
  const scratch = await mkdtemp(join(tmpdir(), 'gridkit-worker-test-'))
  const worker = new Worker(
    fault
      ? `
    const { workerData } = require('node:worker_threads')
    const fs = require('node:fs/promises')
    if (workerData.fault === 'copy') {
      fs.copyFile = async () => { throw Object.assign(new Error('Import copy refused'), { code: 'EACCES' }) }
    } else {
      const remove = fs.rm
      fs.rm = async (path, options) => {
        if (String(path).endsWith('results.csv')) throw Object.assign(new Error('Recording is busy'), { code: 'EBUSY' })
        return remove(path, options)
      }
    }
    require(workerData.entry)
  `
      : entry,
    {
      eval: !!fault,
      workerData: {
        scratch,
        storage,
        fault,
        entry,
        ...(fault === 'cleanup' ? { storageBytes: 0 } : {}),
      },
    },
  )
  let next = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const batches: Extract<FromWorker, { kind: 'batch' }>[] = []
  const rig = {
    scratch,
    worker,
    batches,
    acknowledge: false,
    firstBatch: () => {},
    call<K extends Method>(method: K, input: Requests[K]['input']) {
      const id = ++next
      return {
        id,
        done: new Promise<Requests[K]['output']>((resolve, reject) => {
          pending.set(id, { resolve: (value) => resolve(value as Requests[K]['output']), reject })
          worker.postMessage({ kind: 'request', id, method, input })
        }),
      }
    },
    async stop() {
      await worker.terminate()
      await rm(scratch, { recursive: true, force: true })
    },
  }
  worker.on('message', (message: FromWorker) => {
    if (message.kind === 'batch') {
      batches.push(message)
      rig.firstBatch()
      if (rig.acknowledge) worker.postMessage({ kind: 'ack', id: message.id })
      return
    }
    if (message.kind === 'result' || message.kind === 'error') {
      const operation = pending.get(message.id)
      pending.delete(message.id)
      if (message.kind === 'result') operation?.resolve(message.value)
      else operation?.reject(Object.assign(new Error(message.problem.message), message.problem))
    }
  })
  return rig
}
describe('real worker protocol', () => {
  it('streams many immutable result pages in bounded batches instead of one round trip per page', async () => {
    const rig = await start()
    rig.acknowledge = true
    try {
      const revision = { uri: 'file:///batching.case.json', version: 1 }
      await rig.call('parse', {
        ...revision,
        text: '{"buses":[{"class":"Bus","number":1,"name":"one"}]}',
      }).done
      const path = join(rig.scratch, 'many.csv')
      await writeFile(
        path,
        'time,Bus_one_Vm\n' + Array.from({ length: 4096 }, (_, i) => `${i},${i % 3}\n`).join(''),
      )
      const run = await rig.call('import', { ...revision, path, cacheBytes: 16 << 20 }).done
      expect(run.domains).toEqual({ Bus: { Vm: [0, 2] } })
      rig.batches.length = 0
      const result = await rig.call('batches', {
        ...revision,
        run: run.id,
        fields: [{ from: 'Bus', select: ['Vm'] }],
        includeStatic: false,
      }).done
      expect(result.pages).toBe(64)
      expect(rig.batches.length).toBe(1)
      const samples = rig.batches
        .flatMap((message) => message.batches)
        .filter((batch) => batch.kind === 'samples')
      expect(samples.reduce((sum, batch) => sum + batch.coordinates.length, 0)).toBe(4096)
    } finally {
      await rig.stop()
    }
  })
  it.each(['copy', 'cleanup'] as const)(
    'preserves source files and imported recordings after %s failure',
    async (fault) => {
      const rig = await start(undefined, fault)
      try {
        const revision = { uri: 'file:///failure.case.json', version: 1 }
        await rig.call('parse', {
          ...revision,
          text: '{"buses":[{"class":"Bus","number":1,"name":"one"}]}',
        }).done
        const path = join(rig.scratch, 'original.csv')
        const source = 'time,Bus_one_Vm\n0,1\n1,0.8\n2,1\n'
        await writeFile(path, source)
        const input = { ...revision, path, cacheBytes: 16 << 20 }
        if (fault === 'copy') {
          await expect(rig.call('import', input).done).rejects.toMatchObject({ code: 'EACCES' })
          expect(await rig.call('runs', { uri: revision.uri }).done).toEqual([])
        } else {
          await rig.call('import', input).done
          const info = await rig.call('import', input).done
          expect(info.state).toBe('complete')
          expect(info.domains).toEqual({ Bus: { Vm: [0.8, 1] } })
          const exported = join(rig.scratch, 'exported.csv')
          await rig.call('export', { run: info.id, path: exported }).done
          expect(await readFile(exported, 'utf8')).toContain('0.8')
        }
        expect(await readFile(path, 'utf8')).toBe(source)
      } finally {
        await rig.stop()
      }
    },
  )
  it('rejects stale attachments without releasing a reopened case', async () => {
    const rig = await start()
    try {
      const revision = { uri: 'file:///snapshot.case.json', version: 1, attachmentId: 'first' }
      const text = '{"buses":[{"class":"Bus","number":1,"name":"original"}]}'
      await rig.call('parse', { ...revision, text }).done
      await rig.call('release', { uri: revision.uri, attachmentId: 'first' }).done
      const reopened = await rig.call('parse', {
        ...revision,
        attachmentId: 'second',
        text: text.replace('original', 'changed'),
      }).done
      await rig.call('release', { uri: revision.uri, attachmentId: 'first' }).done
      const query = { kind: 'rows', from: 'Bus', select: ['name'], ids: true } as const
      expect(await rig.call('query', { ...reopened, query }).done).toHaveLength(1)
      await expect(rig.call('query', { ...revision, query }).done).rejects.toThrow(
        /document changed/,
      )
    } finally {
      await rig.stop()
    }
  })
  it('restores recordings in a fresh worker without a case editor', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'gridkit-persistence-'))
    let rig = await start(storage)
    try {
      const revision = { uri: 'file:///retained.case.json', version: 1 }
      await rig.call('parse', {
        ...revision,
        text: '{"buses":[{"class":"Bus","number":1,"name":"one"}]}',
      }).done
      const csv = join(rig.scratch, 'original.csv')
      await writeFile(csv, 'time,Bus_one_Vm\n0,1\n1,0.8\n2,1\n')
      const info = await rig.call('import', { ...revision, path: csv, cacheBytes: 16 << 20 }).done
      const exported = join(storage, 'exported.csv')
      const input = { run: info.id, path: exported }
      await rig.call('export', input).done
      const measured = await readFile(exported, 'utf8')
      await rig.call('release', { uri: revision.uri }).done
      await rig.call('export', input).done
      expect(await readFile(exported, 'utf8')).toEqual(measured)
      await rig.stop()
      rig = await start(storage)
      expect(await rig.call('getSimulation', { simulationId: info.id }).done).toMatchObject({
        id: info.id,
      })
      await rig.call('export', input).done
      expect(await readFile(exported, 'utf8')).toEqual(measured)
      expect(await rig.call('describeSimulation', { simulationId: info.id }).done).toMatchObject({
        fingerprint: info.fingerprint,
      })
      await rig.call('clear', { uri: revision.uri }).done
      await expect(rig.call('export', input).done).rejects.toMatchObject({
        code: 'results-evicted',
        simulationId: info.id,
      })
    } finally {
      await rig.stop()
      await rm(storage, { recursive: true, force: true })
    }
  })
  it('waits for consumption acknowledgements and cancels an unconsumed stream', async () => {
    const rig = await start()
    const { worker, batches, call, stop } = rig
    try {
      const revision = { uri: 'file:///test.case.json', version: 1 }
      await call('parse', {
        ...revision,
        text: await readFile('cases/TwoArea.case.json', 'utf8'),
      }).done
      const received = new Promise<void>((resolve) => {
        rig.firstBatch = resolve
      })
      const stream = call('batches', revision)
      const rejected = expect(stream.done).rejects.toThrow(/Cancelled/)
      await received
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(batches).toHaveLength(1)
      worker.postMessage({ kind: 'cancel', id: stream.id })
      await rejected
      expect(
        (
          await call('query', {
            ...revision,
            query: { kind: 'rows', from: 'Bus', select: ['name'], limit: 100 },
          }).done
        ).length,
      ).toBeGreaterThan(0)
      const edits = await call('transact', {
        ...revision,
        mutations: [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'Delta Ω' }],
      }).done
      const delta = await call('parse', {
        ...revision,
        version: 2,
        baseVersion: 1,
        changes: [edits],
      }).done
      expect(delta.version).toBe(2)
      await expect(
        call('parse', { ...revision, version: 3, baseVersion: 1, changes: [edits] }).done,
      ).rejects.toThrow(/mirror is stale/)
      // A malformed newer revision keeps the old projection unavailable to stale edits.
      await expect(call('parse', { ...revision, version: 4, text: '{' }).done).rejects.toThrow()
      await expect(
        call('transact', {
          ...revision,
          mutations: [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'stale' }],
        }).done,
      ).rejects.toThrow(/changed/)
      await call('release', { uri: revision.uri }).done
      expect(await call('stats', {}).done).toMatchObject({ sessions: 0, runs: 0, cacheBytes: 0 })
    } finally {
      await stop()
    }
  })
  it('sends a view that holds a run only the pages it lacks', async () => {
    const rig = await start()
    const { scratch, batches, call, stop } = rig
    rig.acknowledge = true
    try {
      const revision = { uri: 'file:///test.case.json', version: 1 }
      const text = await readFile('cases/TwoArea.case.json', 'utf8')
      await call('parse', { ...revision, text }).done
      // 200 frames of one bus's voltage: a few pages of results.
      const path = join(scratch, 'waveform.csv')
      const name = JSON.parse(text).buses[0].name
      await writeFile(
        path,
        `time,Bus_${name}_Vm\n` +
          Array.from({ length: 200 }, (_, i) => `${i / 100},${1 + i / 1000}\n`).join(''),
      )
      const run = await call('import', { ...revision, path, cacheBytes: 32 << 20 }).done
      expect(run).toMatchObject({ state: 'complete', frames: 200 })
      // Results that cannot be read fail the import, and take no run's place.
      const broken = join(scratch, 'broken.csv')
      await writeFile(broken, `time,Bus_${name}_Vm\n0,1\n0.01\n`)
      await expect(
        call('import', { ...revision, path: broken, cacheBytes: 32 << 20 }).done,
      ).rejects.toThrow(/does not match its header/)
      expect((await call('runs', { uri: revision.uri }).done).map(({ id }) => id)).toEqual([run.id])
      const stream = { ...revision, fields: run.outputs, run: run.id, includeStatic: false }
      const frames = () =>
        batches
          .flatMap((message) => message.batches)
          .reduce(
            (sum, batch) => sum + (batch.kind === 'samples' ? batch.coordinates.length : 0),
            0,
          )

      const whole = await call('batches', stream).done
      expect(whole.pages).toBeGreaterThan(1)
      expect(frames()).toBe(200)

      // Nothing was published since: the view holds every page.
      batches.length = 0
      expect(await call('batches', { ...stream, fromPage: whole.pages }).done).toEqual(whole)
      expect(batches).toHaveLength(0)

      // A view one page behind is sent that page alone.
      const last = await call('batches', { ...stream, fromPage: whole.pages - 1 }).done
      expect(last).toEqual(whole)
      expect(frames()).toBeGreaterThan(0)
      expect(frames()).toBeLessThan(200)

      // A view that holds a window of the run is sent the pages that overlap it, and no others.
      batches.length = 0
      await call('batches', { ...stream, window: [0.1, 0.2] }).done
      expect(frames()).toBeGreaterThan(0)
      expect(frames()).toBeLessThan(200)

      expect(run.domains).toEqual({ Bus: { Vm: [1, 1.199] } })
      await expect(call('parse', { ...revision, version: 2, text: '{' }).done).rejects.toThrow()
      expect((await call('describeSimulation', { simulationId: run.id }).done).version).toBe(
        revision.version,
      )
      // Clearing a run aborts a stream even when its consumer never acknowledges a batch.
      rig.acknowledge = false
      const received = new Promise<void>((resolve) => {
        rig.firstBatch = resolve
      })
      const held = call('batches', stream)
      const rejected = expect(held.done).rejects.toThrow(/cleared or replaced/)
      await received
      await call('clear', { uri: revision.uri }).done
      await rejected
      expect(await call('stats', {}).done).toMatchObject({ runs: 0, cacheBytes: 0 })
      await expect(call('batches', stream).done).rejects.toThrow(/retained recording/)
    } finally {
      await stop()
    }
  })
})
