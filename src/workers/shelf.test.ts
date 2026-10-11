import { describe, expect, it, vi } from 'vitest'

import type { ResultsFile } from '../results/index.js'
import { Shelf } from './shelf.js'

/** A results file read for case `uri`, the `started`th written, as the shelf sees one. */
function file(uri: string, started: number, more: { growing?: boolean; busy?: boolean } = {}) {
  return {
    info: {
      id: `${uri}#${started}`,
      started,
      growing: more.growing ?? false,
      revision: { uri, version: 1 },
    },
    busy: more.busy ?? false,
    retire: vi.fn(async () => {}),
  } as unknown as ResultsFile & { retire: ReturnType<typeof vi.fn> }
}

describe('the results files read', () => {
  it('lets go of the oldest no one needs once more than eight are read', () => {
    const shelf = new Shelf()
    // The first case's first file, which its second takes the place of.
    const replaced = file('a', 0)
    shelf.keep(replaced)
    const shown = file('a', 1)
    shelf.keep(shown)
    // Another case's, each in turn taking its place but written while others are read.
    const writing = file('b', 2, { growing: true })
    const reading = file('b', 3, { busy: true })
    const kept = [writing, reading, ...[4, 5, 6, 7, 8].map((n) => file('b', n))]
    for (const each of kept) shelf.keep(each)
    // Nine read: the oldest that no case shows, no run writes and no view reads goes.
    expect(shelf.size).toBe(8)
    expect(replaced.retire).toHaveBeenCalledOnce()
    expect(() => shelf.find(replaced.info.id)).toThrow(/no longer read/)
    // The files a case shows, a run writes or a view reads stay however old; past them, the oldest
    // of the rest goes.
    for (const n of [9, 10, 11, 12]) shelf.keep(file('b', n))
    expect(shown.retire).not.toHaveBeenCalled()
    expect(writing.retire).not.toHaveBeenCalled()
    expect(reading.retire).not.toHaveBeenCalled()
    expect(kept[2]!.retire).toHaveBeenCalledOnce()
    expect(kept[3]!.retire).not.toHaveBeenCalled()
    expect(shelf.find(shown.info.id)).toBe(shown)
  })

  it('lets go of every file of a case it clears, and only those', async () => {
    const shelf = new Shelf()
    const [one, two, other] = [file('a', 0), file('a', 1), file('b', 2)]
    for (const each of [one, two, other]) shelf.keep(each)
    await shelf.clear('a')
    expect(one.retire).toHaveBeenCalledOnce()
    expect(two.retire).toHaveBeenCalledOnce()
    expect(other.retire).not.toHaveBeenCalled()
    expect(shelf.size).toBe(1)
    expect(() => shelf.find(two.info.id)).toThrow(
      expect.objectContaining({ code: 'results-unavailable' }),
    )
  })
})
