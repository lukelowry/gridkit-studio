import { afterEach, expect, it, vi } from 'vitest'

import { Recovery } from './recovery.js'

const lost = Object.assign(new Error('lost'), { code: 'device-lost' })

afterEach(() => vi.useRealTimers())

it('coalesces failures, backs off repeated losses and keeps retrying', () => {
  vi.useFakeTimers()
  const restart = vi.fn()
  const report = vi.fn()
  const recovery = new Recovery(restart, report)
  for (const delay of [250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000]) {
    const before = restart.mock.calls.length
    recovery.fail(lost)
    recovery.fail(lost)
    vi.advanceTimersByTime(delay - 1)
    expect(restart).toHaveBeenCalledTimes(before)
    vi.advanceTimersByTime(1)
    expect(restart).toHaveBeenCalledTimes(before + 1)
    recovery.presented() // A briefly working replacement must not reset the backoff.
  }
  expect(report).toHaveBeenCalledTimes(1)
  recovery.fail(lost)
  recovery.dispose()
  vi.advanceTimersByTime(20_000)
  expect(restart).toHaveBeenCalledTimes(8)
})

it('says a restart is pending while it waits out its backoff', () => {
  vi.useFakeTimers()
  const recovery = new Recovery(vi.fn(), vi.fn())
  expect(recovery.pending).toBe(false)
  recovery.fail(lost)
  expect(recovery.pending).toBe(true)
  vi.advanceTimersByTime(250)
  expect(recovery.pending).toBe(false)
  recovery.dispose()
})

it('resets backoff after sustained successful presentation', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const restart = vi.fn()
  const report = vi.fn()
  const recovery = new Recovery(restart, report)
  recovery.fail(lost)
  vi.advanceTimersByTime(250)
  recovery.presented()
  vi.advanceTimersByTime(10_000)
  recovery.presented()
  recovery.fail(lost)
  vi.advanceTimersByTime(250)
  expect(restart).toHaveBeenCalledTimes(2)
  expect(report).toHaveBeenCalledTimes(2)
  recovery.dispose()
})

it('reports contract failures once without remounting and ignores cancelled reads', () => {
  vi.useFakeTimers()
  const restart = vi.fn()
  const report = vi.fn()
  const recovery = new Recovery(restart, report)
  const invalid = Object.assign(new Error('Incomplete rows'), { code: 'invalid-input' })
  recovery.fail(invalid)
  recovery.fail(invalid)
  recovery.fail(new DOMException('The read was let go of.', 'AbortError'))
  recovery.fail(Object.assign(new Error('Closed'), { code: 'results-closed' }))
  vi.advanceTimersByTime(60_000)
  expect(restart).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledOnce()
  expect(recovery.blocked).toBe(true)
  recovery.dispose()
})

it('says a failure again once the view is reloaded, and restarts from the first wait', () => {
  vi.useFakeTimers()
  const restart = vi.fn()
  const report = vi.fn()
  const recovery = new Recovery(restart, report)
  const invalid = Object.assign(new Error('Incomplete rows'), { code: 'invalid-input' })
  recovery.fail(invalid)
  recovery.reset()
  expect(recovery.blocked).toBe(false)
  recovery.fail(invalid)
  expect(report).toHaveBeenCalledTimes(2)
  recovery.reset()
  recovery.fail(lost)
  recovery.reset()
  recovery.fail(lost)
  vi.advanceTimersByTime(250)
  expect(restart).toHaveBeenCalledOnce()
  recovery.dispose()
})
