import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { FromWorker, Method, Requests } from '../src/messages.js'
async function main() {
  const worker = new Worker(join(process.cwd(), 'dist/worker.cjs'), {
    workerData: { scratch: join(process.cwd(), 'output/performance-runs') },
  })
  let next = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  worker.on('message', (message: FromWorker) => {
    if (message.kind === 'batch') worker.postMessage({ kind: 'ack', id: message.id })
    if (message.kind === 'result' || message.kind === 'error') {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.kind === 'error') entry?.reject(new Error(message.message))
      else entry?.resolve(message.value)
    }
  })
  const call = <K extends Method>(method: K, input: Requests[K]['input']) =>
    new Promise<Requests[K]['output']>((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve: (value) => resolve(value as Requests[K]['output']), reject })
      worker.postMessage({ kind: 'request', id, method, input })
    })
  const report: unknown[] = []
  const settled = async () => {
    const snapshot = await worker.getHeapSnapshot()
    for await (const _chunk of snapshot) {
      /* Drain a forced-GC snapshot without retaining it. */
    }
    return call('stats', {})
  }
  try {
    for (const name of ['ACTIVSg2000', 'ACTIVSg10k']) {
      const text = await readFile('cases/' + name + '.case.json', 'utf8')
      const uri = 'file:///' + name + '.case.json'
      let delay = 0
      let previous = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        delay = Math.max(delay, now - previous - 10)
        previous = now
      }, 10)
      const started = performance.now()
      const summary = await call('parse', { uri, version: 1, text })
      const roundtripMs = performance.now() - started
      const latencies: number[] = []
      for (let i = 0; i < 20; i++) {
        const start = performance.now()
        await call('query', {
          uri,
          version: 1,
          query: {
            kind: 'rows',
            from: 'Bus',
            select: ['number', 'name', 'kv'],
            offset: i * 100,
            limit: 100,
            count: true,
            ids: true,
          },
        })
        latencies.push(performance.now() - start)
      }
      const edits = await call('transact', {
        uri,
        version: 1,
        mutations: [
          {
            kind: 'set',
            id: 'Bus/' + JSON.parse(text).buses[0].number,
            field: 'name',
            value: 'Performance Δ',
          },
        ],
      })
      const deltaStart = performance.now()
      await call('parse', { uri, version: 2, baseVersion: 1, changes: [edits] })
      const deltaRoundtripMs = performance.now() - deltaStart
      const deltaBytes = JSON.stringify(edits).length
      clearInterval(timer)
      const size = text.length
      const queryP95Ms = latencies.sort((a, b) => a - b)[18]!
      assert.equal(summary.counts.Bus, name === 'ACTIVSg2000' ? 2000 : 10000)
      const before = process.memoryUsage().rss
      for (let i = 3; i < 6; i++) await call('parse', { uri, version: i, text })
      await call('release', { uri })
      global.gc?.()
      report.push({
        name,
        sourceChars: size,
        parseMs: summary.parseMs,
        roundtripMs,
        queryP95Ms,
        deltaRoundtripMs,
        deltaBytes,
        maxHostTimerDriftMs: delay,
        rssBefore: before,
        rssAfter: process.memoryUsage().rss,
      })
    }
    for (const name of ['ACTIVSg500', 'WECC240']) {
      const path = join(process.cwd(), 'cases', name + '.mon.csv')
      if (!(await stat(path).catch(() => undefined))) continue
      const uri = 'file:///' + name + '.case.json'
      const text = await readFile('cases/' + name + '.case.json', 'utf8')
      await call('parse', { uri, version: 1, text })
      const start = performance.now()
      const run = await call('import', { uri, version: 1, path, cacheBytes: 32 << 20 })
      const stats = await call('stats', {})
      assert.equal(run.state, 'complete', run.message)
      assert.ok(stats.cacheBytes <= 256 << 20)
      report.push({
        name,
        importMs: performance.now() - start,
        frames: run.frames,
        cacheBytes: stats.cacheBytes,
      })
      await call('release', { uri })
    }
    const before = await settled()
    const cycleText = await readFile('cases/ACTIVSg2000.case.json', 'utf8')
    for (let cycle = 0; cycle < 8; cycle++) {
      await call('parse', { uri: 'file:///cycles.case.json', version: cycle + 1, text: cycleText })
      await call('release', { uri: 'file:///cycles.case.json' })
    }
    const after = await settled()
    assert.equal(after.sessions, 0)
    assert.equal(after.runs, 0)
    assert.equal(after.cacheBytes, 0)
    assert.ok(after.memory.heapUsed < before.memory.heapUsed + (24 << 20))
    assert.ok(after.memory.arrayBuffers < before.memory.arrayBuffers + (24 << 20))
    report.push({ name: 'eight open/release cycles after warmup', before, after })
    await writeFile('output/tests/performance-report.json', JSON.stringify(report, null, 2))
    console.log(report)
  } finally {
    await worker.terminate()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
