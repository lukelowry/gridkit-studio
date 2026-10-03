import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

import type { FromWorker, Method, Requests } from '../../src/messages.js'

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
describe('real worker protocol', () => {
  it('waits for consumption acknowledgements and cancels an unconsumed stream', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'gridkit-worker-test-'))
    const worker = new Worker(entry, { workerData: { scratch } })
    let next = 0
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
    const batches: Extract<FromWorker, { kind: 'batch' }>[] = []
    let firstBatch: () => void = () => {}
    worker.on('message', (message: FromWorker) => {
      if (message.kind === 'batch') {
        batches.push(message)
        firstBatch()
        return
      }
      if (message.kind === 'result' || message.kind === 'error') {
        const operation = pending.get(message.id)
        pending.delete(message.id)
        if (message.kind === 'result') operation?.resolve(message.value)
        else operation?.reject(new Error(message.message))
      }
    })
    const call = <K extends Method>(method: K, input: Requests[K]['input']) => {
      const id = ++next
      return {
        id,
        done: new Promise<Requests[K]['output']>((resolve, reject) => {
          pending.set(id, { resolve: (value) => resolve(value as Requests[K]['output']), reject })
          worker.postMessage({ kind: 'request', id, method, input })
        }),
      }
    }
    try {
      const revision = { uri: 'file:///test.case.json', version: 1 }
      await call('parse', {
        ...revision,
        text: await readFile('tests/fixtures/TwoArea.case.json', 'utf8'),
      }).done
      const received = new Promise<void>((resolve) => {
        firstBatch = resolve
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
      // A malformed newer revision keeps the old projection unavailable to stale edits.
      await expect(call('parse', { ...revision, version: 2, text: '{' }).done).rejects.toThrow()
      await expect(
        call('edit', { ...revision, id: 'Bus/1', field: 'name', value: 'stale' }).done,
      ).rejects.toThrow(/changed/)
      await call('release', { uri: revision.uri }).done
      expect(await call('stats', {}).done).toMatchObject({ sessions: 0, runs: 0, cacheBytes: 0 })
    } finally {
      await worker.terminate()
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
