import { createRequire } from 'node:module'

import { Patch } from 'latkit'
import { afterEach, expect, test, vi } from 'vitest'

import type { FramePage, FrameRequest } from '../shared/data.js'
import { loadNative } from '../workers/native.js'
import { FrameReads, FrameWindow } from './frames.js'

const request = vi.hoisted(() => vi.fn())
vi.mock('./bridge.js', () => ({ bridge: { request } }))
vi.mock('./runtime.js', () => ({
  loadRenderer: async () => {
    const { createRequire } = await import('node:module')
    const { loadNative } = await import('../workers/native.js')
    await loadNative(createRequire(import.meta.url).resolve('latkit/wasm'))
  },
}))

await loadNative(createRequire(import.meta.url).resolve('latkit/wasm'))
afterEach(() => request.mockReset())

const input: FrameRequest = {
  results: 'run',
  table: 'Bus',
  field: 'Vm',
  range: [0, 1],
  purpose: 'plot',
  pixels: 800,
  bytes: 16 * 1024 * 1024,
}
function page(key = 'one'): FramePage {
  return {
    key,
    source: 'samples',
    table: 'Bus',
    field: 'Vm',
    complete: true,
    bytes: new Patch('samples')
      .axis('time', 's')
      .replace('Bus', [1])
      .frames('Bus', 'Vm', {
        first: 0,
        level: 0,
        at: Float64Array.of(0, 1),
        values: Float32Array.of(1, 2),
      })
      .toBytes(),
  }
}

test('shared reads survive one subscriber cancelling and cache only immutable patch payloads', async () => {
  const reads = new FrameReads()
  const a = new AbortController()
  const b = new AbortController()
  let finish!: (page: FramePage) => void
  let workerSignal!: AbortSignal
  request.mockImplementation((_method, _input, signal) => {
    workerSignal = signal
    return new Promise<FramePage>((resolve) => {
      finish = resolve
    })
  })
  const first = reads.page(input, 2, a.signal)
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  const second = reads.page(input, 2, b.signal)
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  a.abort()
  await rejected
  expect(workerSignal.aborted).toBe(false)
  const value = page()
  finish(value)
  expect(await second).toBe(value)
  expect(await reads.page(input, 2, new AbortController().signal)).toBe(value)
  expect(request).toHaveBeenCalledTimes(1)
  expect(reads.bytes).toBe(value.bytes.byteLength)
  reads.clear()
  expect(reads.bytes).toBe(0)
})

test('plot detail expands only within its allocation when gaps exceed the compact budget', async () => {
  const reads = new FrameReads()
  const window = new FrameWindow(reads)
  request.mockImplementation(async (_method, read: FrameRequest) => {
    if (read.bytes < input.bytes) throw Object.assign(new Error('Gap detail'), { code: 'limit' })
    return page()
  })
  try {
    expect(await window.plot(input, 2, new AbortController().signal)).toBe(true)
    expect(request.mock.calls.map((call) => call[1].bytes)).toEqual([2 * 1024 * 1024, input.bytes])
    expect(window.range).toEqual([0, 1])
    expect(window.version).toBe(2)
  } finally {
    window.clear()
    reads.clear()
  }
})

test('an aborted late response never replaces the published native dataset', async () => {
  const reads = new FrameReads()
  const window = new FrameWindow(reads)
  request.mockResolvedValueOnce(page('published'))
  await window.receive(input, 2)
  const previous = window.data
  let finish!: (page: FramePage) => void
  request.mockImplementationOnce(
    () =>
      new Promise<FramePage>((resolve) => {
        finish = resolve
      }),
  )
  const controller = new AbortController()
  const pending = window.receive(input, 3, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  controller.abort()
  finish(page('obsolete'))
  await rejected
  expect(window.data).toBe(previous)
  expect(window.version).toBe(2)
  window.clear()
  reads.clear()
})

test('disposing a completed subscriber does not re-ingest its published window', async () => {
  const reads = new FrameReads()
  const window = new FrameWindow(reads)
  const controller = new AbortController()
  request.mockResolvedValue(page())
  await window.receive(input, 2, controller.signal)
  const data = window.data
  controller.abort()
  expect(await window.receive(input, 2, new AbortController().signal)).toBe(false)
  expect(window.data).toBe(data)
  expect(request).toHaveBeenCalledTimes(1)
  window.clear()
  reads.clear()
})
