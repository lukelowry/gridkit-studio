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
async function start() {
  const scratch = await mkdtemp(join(tmpdir(), 'gridkit-worker-test-'))
  const worker = new Worker(entry, { workerData: { scratch } })
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
      else operation?.reject(new Error(message.message))
    }
  })
  return rig
}
describe('real worker protocol', () => {
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
  it('sends a view that holds a run only the pages it lacks, within the bytes it allows', async () => {
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

      await expect(call('batches', { ...stream, maxBytes: 64 }).done).rejects.toThrow(
        /Visible data exceeds/,
      )

      const analysis = { uri: revision.uri, run: run.id, from: 'Bus', field: 'Vm' }
      const measured = await call('analyze', analysis).done
      expect(measured.rows[0]).toMatchObject({
        id: 'Bus/1',
        valid: 200,
        min: { value: 1 },
        max: { value: 1.199, time: 1.99 },
      })
      expect(measured.total).toBe(1)
      await expect(call('analyze', { ...analysis, ids: ['Bus/2'] }).done).rejects.toThrow(
        /not recorded/,
      )
      await expect(
        call('analyze', { ...analysis, uri: 'file:///other.case.json' }).done,
      ).rejects.toThrow(/no longer open/)
      await expect(call('parse', { ...revision, version: 2, text: '{' }).done).rejects.toThrow()
      expect((await call('analyze', analysis).done).revision).toEqual(revision)
      const comparison = await call('compare', {
        before: analysis,
        after: analysis,
        from: 'Bus',
        field: 'Vm',
        window: [0.5, 1],
      }).done
      expect(comparison).toMatchObject({
        matched: 1,
        rows: [{ id: 'Bus/1', minDelta: 0, maxDelta: 0 }],
      })
      await expect(
        call('compare', {
          before: analysis,
          after: analysis,
          from: 'Bus',
          field: 'Vm',
          window: [-1, 1],
        }).done,
      ).rejects.toThrow(/covered by both/)
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
      await expect(call('analyze', analysis).done).rejects.toThrow(/no longer open/)
    } finally {
      await stop()
    }
  })
})
