import { describe, expect, it } from 'vitest'

import { around, pageAt, type PageEntry, pageOf, pagesAt, pagesOver } from './pages.js'

/** Ten pages of ten frames a hundredth of a second apart: page p holds times p/10 to p/10 + 0.09. */
const pages: PageEntry[] = Array.from({ length: 10 }, (_, p) => ({
  first: p * 10,
  count: 10,
  domain: [p / 10, p / 10 + 0.09],
}))
const take = (order: Iterable<number>, count: number) => {
  const taken: number[] = []
  for (const page of order) {
    if (taken.length === count) break
    taken.push(page)
  }
  return taken
}

describe("a run's pages", () => {
  it('finds the page holding a time or a frame', () => {
    expect(pageAt(pages, 0.35)).toBe(3)
    expect(pageAt(pages, -1)).toBe(0)
    expect(pageAt(pages, 5)).toBe(9)
    expect(pageOf(pages, 37)).toBe(3)
    expect(pageOf(pages, 99)).toBe(9)
  })

  it('needs the next page too for a moment after its own page’s last sample', () => {
    expect(pagesAt(pages, 0.35)).toEqual([3, 4])
    expect(pagesAt(pages, 0.395)).toEqual([3, 5])
    expect(pagesAt(pages, 0.995)).toEqual([9, 10])
    expect(pagesAt([], 1)).toEqual([0, 0])
  })

  it('needs the pages over a span and one either side', () => {
    expect(pagesOver(pages, [0.35, 0.55])).toEqual([2, 7])
    expect(pagesOver(pages, [0, 1])).toEqual([0, 10])
  })

  it('orders the other pages by how near they lie, leaning the way a playhead plays', () => {
    expect(take(around(pages, [5, 6], 0.55), 4)).toEqual([6, 4, 7, 3])
    expect(take(around(pages, [5, 6], 0.55, 1), 4)).toEqual([6, 7, 4, 8])
    expect(take(around(pages, [5, 6], 0.55, -1), 4)).toEqual([4, 3, 6, 2])
    // Every page once, to either end.
    expect([...around(pages, [8, 10], 0.85)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})
