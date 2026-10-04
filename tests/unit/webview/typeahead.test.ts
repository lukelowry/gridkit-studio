import { afterEach, describe, expect, it, vi } from 'vitest'

import { nextMatch, Typeahead } from '../../../src/webview/ui/typeahead.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('Typeahead', () => {
  it('spells a lowercase prefix from quick keys and starts over after a pause', () => {
    vi.useFakeTimers()
    const typeahead = new Typeahead()
    expect(typeahead.type('B')).toBe('b')
    vi.advanceTimersByTime(400)
    expect(typeahead.type('u')).toBe('bu')
    vi.advanceTimersByTime(500)
    expect(typeahead.type('s')).toBe('s')
    typeahead.reset()
    expect(typeahead.type('x')).toBe('x')
  })
})

describe('nextMatch', () => {
  const labels = ['alpha', 'beta', 'bravo', 'charlie']
  const text = (index: number) => labels[index]!

  it('finds the next entry with the prefix after the current one, wrapping around', () => {
    expect(nextMatch(4, 1, 'b', text)).toBe(2)
    expect(nextMatch(4, 2, 'b', text)).toBe(1)
    expect(nextMatch(4, 3, 'al', text)).toBe(0)
    expect(nextMatch(4, -1, 'c', text)).toBe(3)
  })

  it('tries the current entry last, and reports -1 when none matches', () => {
    expect(nextMatch(4, 0, 'alpha', text)).toBe(0)
    expect(nextMatch(4, 0, 'z', text)).toBe(-1)
    expect(nextMatch(0, -1, 'a', text)).toBe(-1)
  })
})
