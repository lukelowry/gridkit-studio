import { createRequire } from 'node:module'

import { Patch } from 'latkit'
import { afterEach, expect, test, vi } from 'vitest'

import type { FramePage, FrameRequest } from '../../shared/data.js'
import { loadNative } from '../../workers/native.js'
import { FrameWindow, PlayheadFeed, type Sampled } from './frames.js'

const request = vi.hoisted(() => vi.fn())
vi.mock('../bridge.js', () => ({ bridge: { request } }))
vi.mock('./load.js', () => ({
  loadLatkit: async () => {
    const { createRequire } = await import('node:module')
    const { loadNative } = await import('../../workers/native.js')
    await loadNative(createRequire(import.meta.url).resolve('latkit/wasm'))
  },
}))

await loadNative(createRequire(import.meta.url).resolve('latkit/wasm'))
afterEach(() => request.mockReset())

const input: FrameRequest = { results: 'run', table: 'Bus', field: 'Vm', range: [0, 1], step: 0 }
/** A page of Vm's frames at `times`, named as the results worker names every window of a field. */
function page(times = [0, 1]): FramePage {
  return {
    source: 'samples',
    table: 'Bus',
    field: 'Vm',
    bytes: new Patch('samples')
      .axis('time', 's')
      .replace('Bus', [1])
      .frames('Bus', 'Vm', {
        first: 0,
        level: 0,
        at: Float64Array.from(times),
        values: Float32Array.from(times, (time) => time + 1),
      })
      .toBytes(),
  }
}
/** Answers a request with two seconds of frames from `range[0]`. */
const answer = (_method: string, asked: FrameRequest) =>
  Promise.resolve(page([asked.range[0], asked.range[0] + 2]))

test('an aborted late response never replaces the published native dataset', async () => {
  const window = new FrameWindow()
  request.mockResolvedValueOnce(page())
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
  finish(page())
  await rejected
  expect(window.data).toBe(previous)
  expect(window.version).toBe(2)
  window.clear()
})

test('disposing a completed subscriber does not re-ingest its published window', async () => {
  const window = new FrameWindow()
  const controller = new AbortController()
  request.mockResolvedValue(page())
  await window.receive(input, 2, controller.signal)
  const data = window.data
  controller.abort()
  expect(await window.receive(input, 2, new AbortController().signal)).toBe(false)
  expect(window.data).toBe(data)
  expect(request).toHaveBeenCalledTimes(1)
  window.clear()
})

test('a feed keeps each mapped field around the playhead, and drops fields no longer mapped', async () => {
  const changed = vi.fn()
  const feed = new PlayheadFeed({ changed, failed: vi.fn() })
  const vm: Sampled = ['Bus', 'Vm']
  const results = { id: 'run', frames: 2, domain: [0, 10] as const }
  const still = { results, playing: false, rate: 1, frameRate: 60 }
  const frames = expect.anything()
  request.mockImplementation(answer)
  // Paused, it requests only the frame shown, and reports one change.
  await feed.ahead([vm], 0.5, still)
  expect(request).toHaveBeenLastCalledWith(
    'frames',
    expect.objectContaining({ range: [0.5, 0.5], step: 0 }),
    frames,
  )
  expect(changed).toHaveBeenCalledTimes(1)
  const data = feed.source('Bus', 'Vm')
  expect(data).toBeDefined()
  expect(feed.sources).toEqual([data])
  // It covers the times it read, for no field it has not read, and requests none of them again.
  expect(feed.covers([vm], 0.5)).toBe(true)
  expect(feed.covers([vm], 3)).toBe(false)
  expect(feed.covers([vm, ['Bus', 'Va']], 0.5)).toBe(false)
  request.mockClear()
  await feed.ahead([vm], 0.5, still)
  expect(request).not.toHaveBeenCalled()
  // Playing at twice the speed and 60 fps, the shown window serves, and the next is read from where
  // it ends: two seconds of playback, a thirtieth of a second apart.
  await feed.ahead([vm], 0.6, { ...still, playing: true, rate: 2 })
  await vi.waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(
      'frames',
      expect.objectContaining({ range: [2.5, 6.5], step: 2 / 60 }),
      frames,
    ),
  )
  feed.keep([vm])
  feed.keep([])
  expect(feed.source('Bus', 'Vm')).toBeUndefined()
  expect(feed.sources).toEqual([])
  feed.clear()
})

test('a window read ahead is not a source until shown, since it shares the shown window name', async () => {
  const feed = new PlayheadFeed()
  const vm: Sampled = ['Bus', 'Vm']
  const playing = {
    results: { id: 'run', frames: 9, domain: [0, 10] as const },
    playing: true,
    rate: 1,
  }
  const pace = { ...playing, frameRate: 60 } as const
  request.mockImplementation(answer)
  await feed.ahead([vm], 0, pace)
  await feed.ahead([vm], 0.1, pace)
  // Both windows loaded but one source, as latkit accepts no two datasets with one name.
  await vi.waitFor(() => expect(feed.spans.filter(({ span }) => span)).toHaveLength(2))
  expect(feed.sources).toHaveLength(1)
  const first = feed.source('Bus', 'Vm')
  await feed.ahead([vm], 3, pace)
  expect(feed.source('Bus', 'Vm')).not.toBe(first)
  expect(feed.sources).toEqual([feed.source('Bus', 'Vm')])
  expect(feed.covers([vm], 3)).toBe(true)
  feed.clear()
})

test('a paused seek reads through duplicate fault timestamps and replaces a thinned playback window', async () => {
  const feed = new PlayheadFeed()
  const fields: Sampled[] = [['Bus', 'Vm']]
  const pace = {
    results: { id: 'run', frames: 8, domain: [0, 4] as const },
    playing: false,
    rate: 1,
    frameRate: 60,
  }
  request.mockResolvedValueOnce(page([0, 1]))
  await feed.ahead(fields, 0, pace)
  expect(feed.covers(fields, 0.5, true)).toBe(true)
  expect(feed.covers(fields, 1, true)).toBe(false)
  request.mockResolvedValueOnce(page([1, 1.1]))
  await feed.ahead(fields, 1, pace)
  expect(feed.covers(fields, 1, true)).toBe(true)
  request.mockResolvedValueOnce(page([2, 3, 4]))
  await feed.ahead(fields, 2, { ...pace, playing: true })
  expect(feed.covers(fields, 2.5, true)).toBe(false)
  request.mockResolvedValueOnce(page([2.5, 2.6]))
  await feed.ahead(fields, 2.5, pace)
  expect(request).toHaveBeenLastCalledWith(
    'frames',
    expect.objectContaining({ range: [2.5, 2.5], step: 0 }),
    expect.anything(),
  )
  feed.clear()
})

test('a read that failed is read again once the results or the playhead move, not every frame', async () => {
  const failed = vi.fn()
  const feed = new PlayheadFeed({ changed: vi.fn(), failed })
  const vm: Sampled = ['Bus', 'Vm']
  const still = {
    results: { id: 'run', frames: 2, domain: [0, 10] as const },
    playing: false,
    rate: 1,
  }
  const pace = { ...still, frameRate: 60 } as const
  request.mockRejectedValue(new Error('unreadable'))
  await expect(feed.ahead([vm], 1, pace)).rejects.toThrow('unreadable')
  expect(failed).toHaveBeenCalledTimes(1)
  await feed.ahead([vm], 1, pace)
  expect(request).toHaveBeenCalledTimes(1)
  request.mockImplementation(answer)
  await feed.ahead([vm], 1, { ...pace, results: { ...still.results, frames: 3 } })
  expect(request).toHaveBeenCalledTimes(2)
  expect(feed.covers([vm], 1)).toBe(true)
  expect(failed).toHaveBeenCalledTimes(1)
  feed.clear()
})
