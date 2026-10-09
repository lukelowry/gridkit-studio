import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { SampleBatch } from '@latkit/model'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

import type { FromWorker, Method, Requests, Results } from './shared/messages.js'

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
/** A worker with a folder of files of its own. */
async function start(folder?: string) {
  const scratch = folder ?? (await mkdtemp(join(tmpdir(), 'gridkit-worker-test-')))
  const worker = new Worker(entry)
  let next = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const rig = {
    scratch,
    worker,
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
    if (message.kind === 'result' || message.kind === 'error') {
      const operation = pending.get(message.id)
      pending.delete(message.id)
      if (message.kind === 'result') operation?.resolve(message.value)
      else operation?.reject(Object.assign(new Error(message.problem.message), message.problem))
    }
  })
  return rig
}

/** Everything a view asking for `field` over all of `results` is sent, asking again for what it
 *  lacks until nothing more comes, as a view does. */
async function everything(
  rig: Awaited<ReturnType<typeof start>>,
  results: Results,
  field: Requests['samples']['input']['field'],
) {
  const held: Record<number, number> = {}
  const sent: SampleBatch[] = []
  for (;;) {
    const batches = await rig.call('samples', {
      results: results.id,
      field,
      window: results.domain,
      held,
      bytes: 8 << 20,
    }).done
    if (!batches.length) return sent
    for (const batch of batches) {
      const k = Math.floor(batch.firstFrame / results.chunk)
      held[k] = batch.firstFrame + batch.coordinates.length - k * results.chunk
      sent.push(batch)
    }
  }
}

describe('real worker protocol', () => {
  it('opens, draws and validates a case', async () => {
    const rig = await start()
    try {
      const revision = { uri: 'file:///independent.case.json', version: 1, attachmentId: 'one' }
      const summary = await rig.call('parse', {
        ...revision,
        text: '{"buses":[{"class":"Bus","number":1,"name":"one","mon":["Vm"]}]}',
      }).done
      expect(summary.validation).toBe('pending')
      expect(summary.recording).toEqual({ listed: { Bus: { Vm: 1 } } })
      const rows = await rig.call('rows', {
        ...revision,
        fields: [{ from: 'Bus', select: ['name'] }],
      }).done
      expect(rows.map(({ kind }) => kind)).toEqual(['rows'])
      expect(await rig.call('validate', revision).done).toEqual([])
      await expect(rig.call('validate', { ...revision, attachmentId: 'old' }).done).rejects.toThrow(
        /document changed/,
      )
    } finally {
      await rig.stop()
    }
  })

  it('sends a view every frame of a file once and in order, a chunk at a time', async () => {
    const rig = await start()
    try {
      const revision = { uri: 'file:///chunks.case.json', version: 1 }
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
      const results = await rig.call('open', { ...revision, path, cacheBytes: 64 << 20 }).done
      expect(results.domains).toEqual({ Bus: { Vm: [0, 2] } })
      expect(results.frames).toBeGreaterThan(results.chunk)
      const sent = await everything(rig, results, { from: 'Bus', select: ['Vm'] })
      // Each batch is part of one chunk, and the chunks tile every frame in order.
      for (const batch of sent)
        expect(Math.floor((batch.firstFrame + batch.coordinates.length - 1) / results.chunk)).toBe(
          Math.floor(batch.firstFrame / results.chunk),
        )
      const times = sent
        .sort((a, b) => a.firstFrame - b.firstFrame)
        .flatMap((batch) => Array.from(batch.coordinates))
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
      const results = await rig.call('open', { ...revision, path, cacheBytes: 16 << 20 }).done
      expect(results).toMatchObject({ growing: false, path, frames: 3 })
      expect(results.outputs).toEqual([
        { from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1'] } },
      ])
      expect(results.domains).toEqual({ Bus: { Vm: [0.8, 1] } })
      const exported = join(rig.scratch, 'exported.csv')
      await rig.call('export', { results: results.id, path: exported }).done
      expect(await readFile(exported, 'utf8')).toContain('0.8')
      await rig.call('clear', { uri: revision.uri }).done
      await expect(
        rig.call('export', { results: results.id, path: exported }).done,
      ).rejects.toMatchObject({ code: 'results-unavailable' })
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
      await rig.call('export', { results: first.id, path: exported }).done
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
        chunk: first.chunk,
      })
      await rig.call('export', { results: again.id, path: exported }).done
      expect(await readFile(exported, 'utf8')).toEqual(measured)
      expect(await rig.call('step', { results: again.id, at: 0, direction: 1 }).done).toBe(1)
      expect(await rig.call('describeResults', { results: again.id }).done).toMatchObject({
        fingerprint: again.fingerprint,
      })
      await rig.call('clear', { uri: revision.uri }).done
      await expect(
        rig.call('export', { results: again.id, path: exported }).done,
      ).rejects.toMatchObject({ code: 'results-unavailable' })
    } finally {
      await rig.stop()
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('edits a case through its revisions, and refuses edits to an older one', async () => {
    const rig = await start()
    const { call, stop } = rig
    try {
      const revision = { uri: 'file:///test.case.json', version: 1 }
      await call('parse', {
        ...revision,
        text: await readFile('cases/TwoArea.case.json', 'utf8'),
      }).done
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
      expect(await call('stats', {}).done).toMatchObject({ sessions: 0, results: 0, cacheBytes: 0 })
    } finally {
      await stop()
    }
  })

  it('sends a view only the frames it lacks, and nothing of results let go of', async () => {
    const rig = await start()
    const { scratch, call, stop } = rig
    try {
      const revision = { uri: 'file:///test.case.json', version: 1 }
      const text = await readFile('cases/TwoArea.case.json', 'utf8')
      await call('parse', { ...revision, text }).done
      // 700,000 frames of one bus's voltage: a few chunks of results.
      const path = join(scratch, 'waveform.csv')
      const name = JSON.parse(text).buses[0].name
      const count = 700_000
      await writeFile(
        path,
        `time,Bus_${name}_Vm\n` +
          Array.from({ length: count }, (_, i) => `${i / 100},${1 + (i % 200) / 1000}\n`).join(''),
      )
      const results = await call('open', { ...revision, path, cacheBytes: 64 << 20 }).done
      expect(results).toMatchObject({ growing: false, frames: count })
      expect(results.domains).toEqual({ Bus: { Vm: [1, 1.199] } })
      // Results that cannot be read fail to open.
      const broken = join(scratch, 'broken.csv')
      await writeFile(broken, `time,Bus_${name}_Vm\n0,1\n0.01\n`)
      await expect(
        call('open', { ...revision, path: broken, cacheBytes: 32 << 20 }).done,
      ).rejects.toThrow(/does not match its header/)
      const field = results.outputs[0]!
      const ask = (held: Record<number, number>) =>
        call('samples', {
          results: results.id,
          field,
          window: [results.domain[1], results.domain[1]],
          held,
          bytes: 8 << 20,
        }).done
      // The last moment needs the last chunk, and a view holding it is sent nothing.
      const last = Math.floor((count - 1) / results.chunk)
      const sent = await ask({})
      expect(sent.map(({ firstFrame }) => firstFrame)).toEqual([last * results.chunk])
      expect(await ask({ [last]: count - last * results.chunk })).toEqual([])
      await expect(call('parse', { ...revision, version: 2, text: '{' }).done).rejects.toThrow()
      expect((await call('describeResults', { results: results.id }).done).version).toBe(
        revision.version,
      )
      await call('clear', { uri: revision.uri }).done
      expect(await call('stats', {}).done).toMatchObject({ results: 0, cacheBytes: 0 })
      await expect(ask({})).rejects.toThrow(/no longer read/)
    } finally {
      await stop()
    }
  })
})
