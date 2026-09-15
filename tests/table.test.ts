import { setImmediate } from 'node:timers/promises'

import type { ClassData } from '@latkit/model'
import { loopback, settle } from '@latkit/port/testing'
import { expect, it, vi } from 'vitest'

import { SharedCache } from '../src/cache.js'
import { type Recording, TableEngine } from '../src/table/engine.js'
import { WindowCache } from '../src/table/page/window.js'
import { FrameQueue } from '../src/table/playback.js'
import { isTableRequest } from '../src/table/protocol.js'
import { connectTable, serveTable } from '../src/table/transport.js'

const data = (count = 10000): ClassData => ({
  labels: Array.from({ length: count }, (_, i) => 'Bus ' + i),
  columns: [
    {
      id: 'value',
      label: 'Value',
      kind: 'number',
      values: Float64Array.from({ length: count }, (_, i) => count - i),
    },
  ],
})
const defer = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('reuses immutable query orders for projected reads and identity lookup', async () => {
  const table = new TableEngine(data())
  const spec = { filter: 'bus', sort: { column: 'value', dir: 'asc' } } as const
  const view = await table.query(spec)
  expect((await view.read(20, 2, [0])).rows).toEqual([
    { index: 9979, label: 'Bus 9979', cells: ['21'] },
    { index: 9978, label: 'Bus 9978', cells: ['22'] },
  ])
  expect(await view.locate(9979)).toBe(20)
  const again = await table.query(spec)
  view.close()
  expect(await again.locate(9979)).toBe(20)
  await expect(view.read(0, 1, [0])).rejects.toMatchObject({ name: 'AbortError' })
  expect(await again.locate(10000)).toBeNull()
  await expect(again.read(0, 5000, [0])).rejects.toThrow('window')
  again.close()
  table.close()
})
it('does not format or access hidden columns on a natural viewport read', async () => {
  const hidden = vi.fn(() => {
    throw new Error('Hidden column was read')
  })
  const columns: ClassData['columns'] = [
    { id: 'shown', label: 'Shown', kind: 'number', values: Float64Array.of(1.000000000000002) },
    {
      id: 'hidden',
      label: 'Hidden',
      kind: 'text',
      get values() {
        return hidden()
      },
    },
  ]
  const table = new TableEngine({ labels: ['one'], columns })
  const view = await table.query({ filter: '', sort: null })
  expect((await view.read(0, 1, [0, -1])).rows[0].cells).toEqual(['1.000000000000002', 'one'])
  expect(hidden).not.toHaveBeenCalled()
  table.close()
})
it('preserves stable ties, missing values, flags, and cross-column search', async () => {
  const table = new TableEngine({
    labels: ['A', 'B', 'C', 'D', 'E'],
    columns: [
      {
        id: 'value',
        label: 'Value',
        kind: 'number',
        values: Float64Array.of(2, NaN, 2, Infinity, -Infinity),
      },
      { id: 'flag', label: 'Flag', kind: 'flag', values: Uint8Array.of(1, 0, 1, 0, 1) },
    ],
  })
  const view = await table.query({ filter: '', sort: { column: 'value', dir: 'desc' } })
  expect((await view.read(0, 5, [1])).rows.map((row) => row.index)).toEqual([3, 0, 2, 4, 1])
  const filtered = await table.query({ filter: '2 true', sort: null })
  expect(await filtered.locate(2)).toBe(1)
  expect(await filtered.locate(1)).toBeNull()
  table.close()
})
it('shares an in-flight recorded query without one cancelled caller poisoning another', async () => {
  const started = defer()
  const finish = defer()
  const read = vi.fn(async (_frame, _fields, elements: readonly number[], signal?: AbortSignal) => {
    started.resolve()
    await finish.promise
    signal?.throwIfAborted()
    return new Float64Array(elements.length).fill(42)
  })
  const recording: Recording = { ids: ['@signal:x'], snapshot: async () => ({ frame: 0 }), read }
  const table = new TableEngine(data(20), recording)
  const abort = new AbortController()
  const spec = { filter: '42', sort: null }
  const cancelled = table.query(spec, abort.signal)
  const observed = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  const survivor = table.query(spec)
  await started.promise
  abort.abort()
  finish.resolve()
  await observed
  const view = await survivor
  expect(view.total).toBe(20)
  expect(read).toHaveBeenCalledTimes(1)
  table.close()
})
it('cancels a cold query at a cooperative boundary and remains usable', async () => {
  const table = new TableEngine(data(50000))
  const abort = new AbortController()
  const query = table.query(
    { filter: 'not present', sort: { column: 'value', dir: 'asc' } },
    abort.signal,
  )
  const rejected = expect(query).rejects.toMatchObject({ name: 'AbortError' })
  await setImmediate()
  abort.abort()
  await rejected
  const next = await table.query({ filter: '', sort: null })
  expect((await next.read(49999, 1, [0])).rows[0].index).toBe(49999)
  table.close()
})
it('reuses aligned viewport pages and reads only the requested projection', async () => {
  const table = new TableEngine(data())
  const view = await table.query({ filter: '', sort: null })
  const read = vi.spyOn(view, 'read')
  const pages = new WindowCache(view)
  await pages.read(20, 40, [0])
  expect((await pages.read(21, 40, [0])).rows[0].index).toBe(21)
  expect(read).toHaveBeenCalledTimes(1)
  await pages.read(120, 40, [0])
  expect(read).toHaveBeenCalledTimes(2)
  await pages.read(21, 40, [-1])
  expect(read).toHaveBeenLastCalledWith(0, 128, [-1], expect.any(AbortSignal))
  pages.close()
  table.close()
})
it('bounds cached memory and cancels a shared build when its last reader leaves', async () => {
  const cache = new SharedCache<number[]>(16, (value) => value.length * 8)
  const build = vi.fn(async () => [1, 2])
  await cache.get('a', build)
  await cache.get('b', build)
  await cache.get('a', build)
  expect(build).toHaveBeenCalledTimes(3)
  const abort = new AbortController()
  const started = defer<AbortSignal>()
  const pending = cache.get(
    'pending',
    (signal) => {
      started.resolve(signal)
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    },
    abort.signal,
  )
  const observed = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const signal = await started.promise
  abort.abort()
  await observed
  expect(signal.aborted).toBe(true)
  cache.clear()
})
it('publishes valid playback work and skips superseded pending frames', async () => {
  const release = defer()
  const done = defer()
  const published: number[] = []
  const failed = vi.fn()
  const queue = new FrameQueue<number>(async (frame, signal) => {
    if (frame === 1) await release.promise
    signal.throwIfAborted()
    published.push(frame)
    if (frame === 4) done.resolve()
  }, failed)
  queue.request(1)
  queue.request(2)
  queue.request(3)
  queue.request(4)
  release.resolve()
  await done.promise
  expect(published).toEqual([1, 4])
  expect(failed).not.toHaveBeenCalled()
  queue.close()
  queue.request(5)
  await setImmediate()
  expect(published).toEqual([1, 4])
})
it('closes remote query leases, rejects stale reads, and validates request sizes', async () => {
  const [host, page] = loopback()
  const engine = new TableEngine(data())
  const service = serveTable(host, 'test', engine)
  const table = connectTable(page, 'test', engine.rowCount)
  for (let i = 0; i < 12; i++) {
    const view = await table.query({ filter: '', sort: null })
    expect(await view.locate(i)).toBe(i)
    view.close()
    await expect(view.read(0, 1, [0])).rejects.toThrow('closed')
  }
  expect(isTableRequest({ type: 'read', view: 'x', offset: 0, count: 5000, columns: [0] })).toBe(
    false,
  )
  expect(
    isTableRequest({ type: 'query', view: 'x', spec: { filter: '', sort: null, frameCount: -1 } }),
  ).toBe(false)
  table.close()
  await settle()
  service.close()
})
