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
/** A worker with a folder of files of its own, every batch it sends kept. A batch is acknowledged
 *  as it arrives only while `acknowledge` is on. */
async function start(folder?: string) {
  const scratch = folder ?? (await mkdtemp(join(tmpdir(), 'gridkit-worker-test-')))
  const worker = new Worker(entry)
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
      if (!folder) await rm(scratch, { recursive: true, force: true })
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
  it('opens, draws and validates a case', async () => {
    const rig = await start()
    rig.acknowledge = true
    try {
      const revision = { uri: 'file:///independent.case.json', version: 1, attachmentId: 'one' }
      const summary = await rig.call('parse', {
        ...revision,
        text: '{"buses":[{"class":"Bus","number":1,"name":"one","mon":["Vm"]}]}',
      }).done
      expect(summary.validation).toBe('pending')
      expect(summary.recording).toEqual({ listed: { Bus: { Vm: 1 } } })
      await rig.call('batches', { ...revision, fields: [{ from: 'Bus', select: ['name'] }] }).done
      expect(rig.batches).toHaveLength(1)
      expect(await rig.call('validate', revision).done).toEqual([])
      await expect(rig.call('validate', { ...revision, attachmentId: 'old' }).done).rejects.toThrow(
        /document changed/,
      )
    } finally {
      await rig.stop()
    }
  })

  it('streams every frame of a run once and in order, across its pages', async () => {
    const rig = await start()
    rig.acknowledge = true
    try {
      const revision = { uri: 'file:///batching.case.json', version: 1 }
      await rig.call('parse', {
        ...revision,
        text: '{"buses":[{"class":"Bus","number":1,"name":"one"}]}',
      }).done
      const path = join(rig.scratch, 'many.csv')
      const frames = 600_000
      await writeFile(
        path,
        'time,Bus_one_Vm\n' + Array.from({ length: frames }, (_, i) => `${i},${i % 3}\n`).join(''),
      )
      const run = await rig.call('open', { ...revision, path, cacheBytes: 64 << 20 }).done
      expect(run.domains).toEqual({ Bus: { Vm: [0, 2] } })
      rig.batches.length = 0
      await rig.call('batches', {
        ...revision,
        run: run.id,
        fields: [{ from: 'Bus', select: ['Vm'] }],
        includeStatic: false,
      }).done
      // The pages tile every frame in order.
      const { pages } = await rig.call('pages', { run: run.id, from: 0 }).done
      expect(pages.length).toBeGreaterThan(1)
      expect(
        pages.reduce((first, page) => (page.first === first ? first + page.count : NaN), 0),
      ).toBe(frames)
      const times = rig.batches
        .flatMap((message) => message.batches)
        .flatMap((batch) => (batch.kind === 'samples' ? Array.from(batch.coordinates) : []))
      expect(times).toHaveLength(frames)
      expect(times.every((time, i) => time === i)).toBe(true)
    } finally {
      await rig.stop()
    }
  })

  it('reads a results file where it is, says what it holds, and never changes it', async () => {
    const rig = await start()
    try {
      const revision = { uri: 'file:///in-place.case.json', version: 1 }
      await rig.call('parse', {
        ...revision,
        text: '{"buses":[{"class":"Bus","number":1,"name":"one"}]}',
      }).done
      const path = join(rig.scratch, 'original.csv')
      const source = 'time,Bus_one_Vm\n0,1\n1,0.8\n2,1\n'
      await writeFile(path, source)
      const info = await rig.call('open', { ...revision, path, cacheBytes: 16 << 20 }).done
      expect(info).toMatchObject({ state: 'complete', path, frames: 3 })
      expect(info.outputs).toEqual([
        { from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1'] } },
      ])
      expect(info.domains).toEqual({ Bus: { Vm: [0.8, 1] } })
      const exported = join(rig.scratch, 'exported.csv')
      await rig.call('export', { run: info.id, path: exported }).done
      expect(await readFile(exported, 'utf8')).toContain('0.8')
      await rig.call('clear', { uri: revision.uri }).done
      expect(await rig.call('runs', { uri: revision.uri }).done).toEqual([])
      // Clearing lets go of the results; the file is the user's, and stays as it was.
      expect(await readFile(path, 'utf8')).toBe(source)
    } finally {
      await rig.stop()
    }
  })

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

  it('reads the same file again in a fresh worker, as a reload does', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gridkit-reload-'))
    const revision = { uri: 'file:///reloaded.case.json', version: 1 }
    const text = '{"buses":[{"class":"Bus","number":1,"name":"one"}]}'
    const csv = join(folder, 'results.csv')
    await writeFile(csv, 'time,Bus_one_Vm\n0,1\n1,0.8\n2,1\n')
    let rig = await start(folder)
    try {
      await rig.call('parse', { ...revision, text }).done
      const first = await rig.call('open', { ...revision, path: csv, cacheBytes: 16 << 20 }).done
      const exported = join(folder, 'exported.csv')
      await rig.call('export', { run: first.id, path: exported }).done
      const measured = await readFile(exported, 'utf8')
      await rig.stop()
      rig = await start(folder)
      await rig.call('parse', { ...revision, text }).done
      const again = await rig.call('open', { ...revision, path: csv, cacheBytes: 16 << 20 }).done
      expect(again).toMatchObject({
        frames: first.frames,
        domain: first.domain,
        domains: first.domains,
        outputs: first.outputs,
      })
      await rig.call('export', { run: again.id, path: exported }).done
      expect(await readFile(exported, 'utf8')).toEqual(measured)
      expect(await rig.call('step', { run: again.id, at: 0, direction: 1 }).done).toBe(1)
      expect(await rig.call('describeSimulation', { simulationId: again.id }).done).toMatchObject({
        fingerprint: again.fingerprint,
      })
      await rig.call('clear', { uri: revision.uri }).done
      await expect(
        rig.call('export', { run: again.id, path: exported }).done,
      ).rejects.toMatchObject({ code: 'results-unavailable', simulationId: again.id })
    } finally {
      await rig.stop()
      await rm(folder, { recursive: true, force: true })
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

  it('sends a view the pages it asks for, and no others', async () => {
    const rig = await start()
    const { scratch, batches, call, stop } = rig
    rig.acknowledge = true
    try {
      const revision = { uri: 'file:///test.case.json', version: 1 }
      const text = await readFile('cases/TwoArea.case.json', 'utf8')
      await call('parse', { ...revision, text }).done
      // 700,000 frames of one bus's voltage: a few pages of results.
      const path = join(scratch, 'waveform.csv')
      const name = JSON.parse(text).buses[0].name
      const count = 700_000
      await writeFile(
        path,
        `time,Bus_${name}_Vm\n` +
          Array.from({ length: count }, (_, i) => `${i / 100},${1 + (i % 200) / 1000}\n`).join(''),
      )
      const run = await call('open', { ...revision, path, cacheBytes: 64 << 20 }).done
      expect(run).toMatchObject({ state: 'complete', frames: count })
      // Results that cannot be read fail to open, and take no run's place.
      const broken = join(scratch, 'broken.csv')
      await writeFile(broken, `time,Bus_${name}_Vm\n0,1\n0.01\n`)
      await expect(
        call('open', { ...revision, path: broken, cacheBytes: 32 << 20 }).done,
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

      await call('batches', stream).done
      expect(frames()).toBe(count)
      const { paging, pages } = await call('pages', { run: run.id, from: 0 }).done
      expect(pages.length).toBeGreaterThan(1)
      // A run lists the pages it published after those a view was told of.
      expect(await call('pages', { run: run.id, from: pages.length - 1 }).done).toEqual({
        paging,
        pages: pages.slice(-1),
      })
      // Pages asked for as another reading cut the run are refused.
      await expect(
        call('batches', { ...stream, pages: [0, 1], paging: 'another' }).done,
      ).rejects.toMatchObject({ code: 'conflict' })

      // No page asked for, none sent.
      batches.length = 0
      expect(await call('batches', { ...stream, pages: [1, 1] }).done).toEqual({ coverage: [] })
      expect(batches).toHaveLength(0)

      // The last page alone: its frames, and the coverage that says so.
      const last = pages.length - 1
      const { coverage } = await call('batches', { ...stream, pages: [last, last + 1], paging })
        .done
      expect(frames()).toBe(pages[last]!.count)
      expect(coverage[0]).toMatchObject({ first: pages[last]!.first, count: pages[last]!.count })

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
      await expect(call('batches', stream).done).rejects.toThrow(/no longer read/)
    } finally {
      await stop()
    }
  })
})
