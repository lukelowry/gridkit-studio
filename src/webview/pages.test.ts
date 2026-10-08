import {
  appendedPages,
  blockByteLength,
  createData,
  type SampleBatch,
  textColumn,
} from '@latkit/model'
import { describe, expect, it, vi } from 'vitest'

import { coversTime } from '../shared/coverage.js'
import type { Summary, ViewState } from '../shared/messages.js'
import type { PageEntry, Want } from '../shared/pages.js'
import { exportNeeds, type Need, networkNeeds, PageStore, plotNeeds } from './pages.js'

const index = { source: 'case', type: 'Bus', version: 'one' }
const schema = {
  types: {
    Bus: {
      fields: {
        Vm: { type: 'float64' as const, sampled: true as const },
        Va: { type: 'float64' as const, sampled: true as const },
        kv: { type: 'float64' as const },
      },
    },
  },
}
const rows = createData(schema, [
  {
    kind: 'rows',
    index,
    rows: { kind: 'range', offset: 0, count: 2 },
    ids: textColumn(['Bus/1', 'Bus/2']),
    columns: {},
  },
])
/** Six pages of four frames: page p holds times p to p + 0.75. */
const directory: PageEntry[] = Array.from({ length: 6 }, (_, p) => ({
  first: p * 4,
  count: 4,
  domain: [p, p + 0.75],
}))
/** Page `p` of `field`, for both buses. */
const batch = (p: number, field = 'Vm'): SampleBatch => ({
  kind: 'samples',
  index,
  rows: { kind: 'range', offset: 0, count: 2 },
  firstFrame: p * 4,
  coordinates: Float64Array.of(p, p + 0.25, p + 0.5, p + 0.75),
  columns: {
    [field]: {
      kind: 'numeric',
      values: new Float64Array(8).fill(p),
      offset: 0,
      length: 8,
      rowStride: 1,
      frameStride: 2,
    },
  },
})
const need = (field: string, count = 2): Need => ({
  selection: { from: 'Bus', select: [field] },
  rows: count,
})
const vm = need('Vm')
const va = need('Va')
const pages = (send: ReturnType<typeof vi.fn>) =>
  (send.mock.lastCall![0] as { wants: Want[] }).wants.map(({ page }) => page)

describe('the pages a view holds', () => {
  it('asks for what a moment needs, then the nearest pages, leaning ahead while playing, as far as its budget reaches', () => {
    const send = vi.fn()
    // Three pages of a thousand rows fit.
    const wide = need('Vm', 1000)
    const store = new PageStore(send, 3 * 4 * 1000 * 8)
    // Nothing is asked before the run's pages are known.
    store.want('run', [wide], [2, 3], { at: 2.1, travel: 1 })
    expect(send).not.toHaveBeenCalled()
    store.list('run', 'cut', 0, directory)
    store.want('run', [wide], [2, 3], { at: 2.1, travel: 1 })
    expect(send).toHaveBeenLastCalledWith({
      run: 'run',
      paging: 'cut',
      required: 1,
      wants: [2, 3, 1].map((page) => ({ page, fields: [wide.selection] })),
    })
    // A moment on the same page has nothing new to say; nor has a page arriving.
    store.want('run', [wide], [2, 3], { at: 2.4, travel: 1 })
    store.insert('run', 'cut', [batch(2)], 1)
    store.want('run', [wide], [2, 3], { at: 2.1, travel: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    // A moment on another page asks for that page first. The page held counts toward the budget.
    store.want('run', [wide], [4, 5], { at: 4.1, travel: -1 })
    expect(pages(send)).toEqual([4, 3])
  })

  it('holds each page once, draws from what it holds, and keeps what it drew while that covers the moment', () => {
    const store = new PageStore(() => {})
    store.list('run', 'cut', 0, directory)
    store.want('run', [vm], [3, 4], { at: 3.1, travel: 0 })
    // A page sent ahead arrives before the moment's own, and the moment's twice.
    store.insert('run', 'cut', [batch(4)], 1)
    store.insert('run', 'cut', [batch(3)], 2)
    store.insert('run', 'cut', [batch(3)], 3)
    const data = store.data(rows, 'run')
    expect(coversTime(data, 'Bus', 'Vm', 3.5)).toBe(true)
    expect(coversTime(data, 'Bus', 'Vm', 4.5)).toBe(true)
    expect(store.stats().held).toBe(2)
    expect(store.stream).toBe(2)
    // Another page sent ahead changes nothing drawn, until a moment on it.
    store.insert('run', 'cut', [batch(1)], 4)
    expect(store.data(rows, 'run')).toBe(data)
    store.want('run', [vm], [1, 2], { at: 1.1, travel: 0 })
    const moved = store.data(rows, 'run')
    expect(moved).not.toBe(data)
    expect(coversTime(moved, 'Bus', 'Vm', 1.5)).toBe(true)
    // A gap between pages is no coverage.
    expect(coversTime(moved, 'Bus', 'Vm', 2.5)).toBe(false)
    // Another run's view draws the rows alone.
    expect(store.data(rows, 'other')).toBe(rows)
  })

  it('appends pages that follow those drawn, so a plot keeps the lines it drew', () => {
    const store = new PageStore(() => {})
    store.list('run', 'cut', 0, directory.slice(0, 2))
    store.want('run', [vm], [0, 2])
    store.insert('run', 'cut', [batch(0), batch(1)], 1)
    const before = store.data(rows, 'run')
    store.list('run', 'cut', 2, directory.slice(2, 3))
    store.want('run', [vm], [0, 3])
    store.insert('run', 'cut', [batch(2)], 2)
    const after = store.data(rows, 'run')
    expect(after).not.toBe(before)
    expect(appendedPages(before.tables.Bus!.fields.Vm!, after.tables.Bus!.fields.Vm!)).toBeDefined()
  })

  it('past its budget lets the farthest pages go, never those a moment needs, and asks for them again', () => {
    const send = vi.fn()
    const page = blockByteLength([batch(0)])
    const store = new PageStore(send, 2 * page + 1)
    store.list('run', 'cut', 0, directory)
    store.want('run', [vm], [2, 3], { at: 2.1, travel: 0 })
    expect(pages(send).slice(0, 3)).toEqual([2, 1, 3])
    store.insert('run', 'cut', [batch(2), batch(1), batch(3)], 1)
    expect(store.stats().held).toBe(2)
    expect(store.holds([1, 3])).toBe(true)
    store.want('run', [vm], [2, 3], { at: 2.1, travel: 0 })
    expect(pages(send)).toContain(3)
    expect(pages(send)).not.toContain(2)
  })

  it('asks for a new field alone, and lets go a field no longer drawn', () => {
    const send = vi.fn()
    const store = new PageStore(send)
    store.list('run', 'cut', 0, directory)
    store.want('run', [vm], [1, 2])
    store.insert('run', 'cut', [batch(1, 'Vm')], 1)
    store.want('run', [vm, va], [1, 2])
    expect(send.mock.lastCall![0].wants).toEqual([{ page: 1, fields: [va.selection] }])
    store.insert('run', 'cut', [batch(1, 'Va')], 2)
    store.data(rows, 'run')
    expect(store.sampled('run')).toEqual([vm.selection, va.selection])
    expect(store.sampled('other')).toEqual([])
    store.want('run', [va], [1, 2])
    expect(store.stats().held).toBe(1)
    // Another run starts over.
    store.list('other', 'cut', 0, directory)
    expect(store.stats()).toMatchObject({ held: 0, bytes: 0 })
  })

  it('assembles whatever arrives, in any order, for any moment and run, and draws what it holds', () => {
    // A small generator, so each run tries the same orders.
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 48271) % 2147483647
      return seed % n
    }
    const page = blockByteLength([batch(0)])
    for (let trial = 0; trial < 50; trial++) {
      const store = new PageStore(() => {}, (2 + random(4)) * page)
      // Each run's samples hold its own values: the first run's page p holds p, the second's p + 100.
      let run = 'first'
      const offset = () => (run === 'first' ? 0 : 100)
      store.list(run, 'cut', 0, directory)
      for (let step = 0; step < 30; step++) {
        if (!random(8)) {
          run = run === 'first' ? 'second' : 'first'
          store.list(run, 'cut', 0, directory)
        }
        const needs = random(4) ? [vm] : [vm, va]
        const at = random(directory.length)
        store.want(run, needs, [at, at + 1], { at: at + 0.1, travel: random(3) - 1 })
        // A stream brings each field of a page once; another stream may bring it again.
        const first = random(6)
        const field = random(2) ? 'Vm' : 'Va'
        const arriving = [batch(first, field), batch((first + 1 + random(5)) % 6, field)]
        for (const sample of arriving)
          (Object.values(sample.columns)[0] as { values: Float64Array }).values.fill(
            sample.firstFrame / 4 + offset(),
          )
        store.insert(run, 'cut', arriving, step + 1)
        const data = store.data(rows, run)
        // Every page drawn is this run's own.
        for (const pages of Object.values(data.tables.Bus!.fields))
          for (const { column, samples } of pages!)
            expect((column as { values: Float64Array }).values[0]).toBe(
              samples!.firstFrame / 4 + offset(),
            )
        for (const { selection } of needs)
          if (store.holds([at, at + 1]))
            expect(coversTime(data, 'Bus', selection.select[0]!, at + 0.5)).toBe(true)
      }
    }
  })

  it("draws another run's own samples, though its pages are named as the last run's were", () => {
    const store = new PageStore(() => {})
    const valueAt = (data: ReturnType<typeof store.data>) =>
      [...data.tables.Bus!.fields.Vm!].map(
        (page) => (page.column as { values: Float64Array }).values[0],
      )
    store.list('first', 'cut', 0, directory)
    store.want('first', [vm], [0, 1])
    store.insert('first', 'cut', [batch(0)], 1)
    expect(valueAt(store.data(rows, 'first'))).toEqual([0])
    // The next run's page 0 holds other values.
    store.list('second', 'cut', 0, directory)
    store.want('second', [vm], [0, 1])
    expect(valueAt(store.data(rows, 'second'))).toEqual([])
    const next = batch(0)
    ;(next.columns.Vm as { values: Float64Array }).values.fill(42)
    store.insert('second', 'cut', [next], 2)
    expect(valueAt(store.data(rows, 'second'))).toEqual([42])
    store.insert('second', 'cut', [batch(1)], 3)
    store.want('second', [vm], [1, 2])
    expect(valueAt(store.data(rows, 'second')).sort()).toEqual([1, 42])
  })

  it('starts over when its run is cut into pages anew, and takes none of the old pages', () => {
    const send = vi.fn()
    const store = new PageStore(send)
    store.list('run', 'cut', 0, directory)
    store.want('run', [vm], [1, 2])
    store.insert('run', 'cut', [batch(1)], 1)
    // Read again, the run is cut at other frames: its page 1 is no longer these frames.
    store.list('run', 'recut', 0, directory.slice(0, 3))
    expect(store.stats()).toMatchObject({ listed: 3, held: 0 })
    store.insert('run', 'cut', [batch(1)], 2)
    expect(store.stats().held).toBe(0)
    store.want('run', [vm], [1, 2])
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ paging: 'recut' }))
  })
})

describe('the fields each view needs', () => {
  const summary = {
    uri: 'file:///case',
    version: 1,
    fingerprint: 'case',
    schema,
    counts: { Bus: 2 },
  } as unknown as Summary
  const run = {
    id: 'run',
    fingerprint: 'case',
    frames: 24,
    domain: [0, 5.75],
    outputs: [{ from: 'Bus', select: ['Vm', 'Va'] }],
  } as unknown as ViewState['run']
  const state: ViewState = {
    summary,
    run,
    bindings: {
      vertexColor: { type: 'Bus', field: 'Vm' },
      vertexHeight: { type: 'Bus', field: 'kv' },
    },
    plots: [
      { from: 'Bus', field: 'Vm', id: 'Bus/1' },
      { from: 'Bus', field: 'Va', id: 'Bus/1' },
      { from: 'Bus', field: 'Va', id: 'Bus/2' },
    ],
  }

  it('maps the sampled fields of a run of this revision for every row', () => {
    expect(networkNeeds(state)).toEqual([vm])
    expect(networkNeeds({ ...state, run: { ...run!, fingerprint: 'older' } })).toEqual([])
  })

  it('plots the rows plots name, or every row once a plot shows them all', () => {
    expect(plotNeeds(state)).toEqual([
      {
        selection: { from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1'] } },
        rows: 1,
      },
      {
        selection: { from: 'Bus', select: ['Va'], rows: { kind: 'ids', ids: ['Bus/1', 'Bus/2'] } },
        rows: 2,
      },
    ])
    expect(
      plotNeeds({ ...state, plots: [...state.plots!, { from: 'Bus', field: 'Vm' }] })[0],
    ).toEqual(vm)
  })

  it('exports each field once, for every row either view reads it for', () => {
    expect(exportNeeds(state, ['network', 'monitor'])).toEqual([vm, plotNeeds(state)[1]])
    expect(exportNeeds(state, ['monitor'])).toEqual(plotNeeds(state))
  })
})
