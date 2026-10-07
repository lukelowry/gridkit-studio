import { afterEach, expect, it, vi } from 'vitest'

import { packed, StreamDelivery } from './stream.js'

it('sends a message of more buffers than VS Code counts as one buffer of views', () => {
  const few = { arrays: [Float64Array.of(1), Uint32Array.of(2)] }
  expect(packed(few)).toBe(few)
  const coordinates = Float64Array.of(0.5)
  const message = {
    kind: 'batch',
    batches: Array.from({ length: 300 }, (_, i) => ({
      coordinates,
      values: Float64Array.of(i, i + 0.5),
      rows: Uint32Array.of(i),
      at: i,
    })),
  }
  const sent = packed(message)
  const views = sent.batches.flatMap(({ coordinates, values, rows }) => [coordinates, values, rows])
  expect(new Set(views.map((view) => view.buffer)).size).toBe(1)
  // Each array is a view of its own type, holding what it held; one array stays one view.
  expect(sent.batches.map(({ values }) => Array.from(values))).toEqual(
    message.batches.map(({ values }) => Array.from(values)),
  )
  expect(sent.batches[299]!.rows).toBeInstanceOf(Uint32Array)
  expect(Array.from(sent.batches[299]!.rows)).toEqual([299])
  expect(sent.batches[0]!.coordinates).toBe(sent.batches[299]!.coordinates)
  expect(sent.batches[7]!.at).toBe(7)
})

afterEach(() => vi.useRealTimers())

it('waits for the matching commit, never a batch receipt or an older stream', async () => {
  const delivery = new StreamDelivery(async () => true)
  const done = vi.fn()
  const pending = delivery
    .post({ kind: 'end', stream: 2, coverage: [] }, new AbortController().signal)
    .then(done)
  delivery.receive({ kind: 'ack', stream: 2, sequence: 1 })
  delivery.receive({ kind: 'commit', stream: 1 })
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  delivery.receive({ kind: 'commit', stream: 2 })
  await pending
  expect(done).toHaveBeenCalledOnce()
})

it('preserves typed rejection and accepts the next replacement', async () => {
  const delivery = new StreamDelivery(async () => true)
  const signal = new AbortController().signal
  const pending = delivery.post({ kind: 'end', stream: 1, coverage: [] }, signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'conflict' })
  delivery.receive({ kind: 'commit', stream: 1, error: { code: 'conflict', message: 'No base' } })
  await rejected
  const retry = delivery.post({ kind: 'end', stream: 2, coverage: [] }, signal)
  delivery.receive({ kind: 'commit', stream: 1 })
  delivery.receive({ kind: 'commit', stream: 2 })
  await retry
})

it('times out lost commit receipts and releases cancellation listeners', async () => {
  vi.useFakeTimers()
  const delivery = new StreamDelivery(async () => true)
  const control = new AbortController()
  const pending = delivery.post({ kind: 'end', stream: 1, coverage: [] }, control.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  const retry = delivery.post(
    { kind: 'batch', stream: 2, sequence: 1, batches: [] },
    control.signal,
  )
  const aborted = expect(retry).rejects.toMatchObject({ name: 'AbortError' })
  control.abort()
  await aborted
  expect(vi.getTimerCount()).toBe(0)
})

it.each([false, new Error('send failed')])('cleans up failed sends: %s', async (outcome) => {
  vi.useFakeTimers()
  const delivery = new StreamDelivery(() => {
    if (outcome instanceof Error) throw outcome
    return Promise.resolve(outcome)
  })
  await expect(
    delivery.post({ kind: 'end', stream: 1, coverage: [] }, new AbortController().signal),
  ).rejects.toThrow()
  expect(vi.getTimerCount()).toBe(0)
})
