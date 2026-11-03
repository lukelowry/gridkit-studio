import { describe, expect, it, vi } from 'vitest'

import { ResultCache } from './cache.js'

describe('what a worker keeps of the results files nothing holds', () => {
  it('keeps a file under the budget until it is opened again or past it, longest resting first', () => {
    const cache = new ResultCache(4)
    const [first, woken, second] = [vi.fn(), vi.fn(), vi.fn()]
    cache.rest({}, 2, first)
    const opened = {}
    cache.rest(opened, 1, woken)
    cache.wake(opened)
    expect(cache.bytes).toBe(2)
    // A file resting after it pushes the first out.
    cache.rest({}, 3, second)
    expect(first).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(3)
    expect(woken).not.toHaveBeenCalled()
    // A lower limit lets go at once, and a file larger than the whole budget is never kept.
    cache.limit = 2
    expect(second).toHaveBeenCalledOnce()
    const large = vi.fn()
    cache.rest({}, 3, large)
    expect(large).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(0)
  })
})
