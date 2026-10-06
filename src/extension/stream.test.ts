import { afterEach, expect, it, vi } from 'vitest'

import { StreamDelivery } from './stream.js'

afterEach(() => vi.useRealTimers())

it('waits for the matching commit, never a batch receipt or an older stream', async () => {
  const delivery = new StreamDelivery(async () => true)
  const done = vi.fn()
  const pending = delivery.post({ kind: 'end', stream: 2 }, new AbortController().signal).then(done)
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
  const pending = delivery.post({ kind: 'end', stream: 1 }, signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'conflict' })
  delivery.receive({ kind: 'commit', stream: 1, error: { code: 'conflict', message: 'No base' } })
  await rejected
  const retry = delivery.post({ kind: 'end', stream: 2 }, signal)
  delivery.receive({ kind: 'commit', stream: 1 })
  delivery.receive({ kind: 'commit', stream: 2 })
  await retry
})

it('times out lost commit receipts and releases cancellation listeners', async () => {
  vi.useFakeTimers()
  const delivery = new StreamDelivery(async () => true)
  const control = new AbortController()
  const pending = delivery.post({ kind: 'end', stream: 1 }, control.signal)
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
    delivery.post({ kind: 'end', stream: 1 }, new AbortController().signal),
  ).rejects.toThrow()
  expect(vi.getTimerCount()).toBe(0)
})
