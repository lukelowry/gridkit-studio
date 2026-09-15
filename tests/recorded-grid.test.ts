import type { ClassData } from '@latkit/model'
import { expect, it, vi } from 'vitest'

import { type Recording, TableEngine } from '../src/table/engine.js'

it('pins recorded filtering, ordering, and projected values to the captured frame', async () => {
  const data: ClassData = { labels: ['A', 'B', 'unrecorded'], columns: [] }
  let time = 0
  const recording: Recording = {
    ids: ['@signal:Vm'],
    snapshot: async (spec) => ({ frame: spec.frame ?? time, time }),
    read: vi.fn(async (frame: number, fields: readonly number[], elements: readonly number[]) =>
      Float64Array.from(
        elements.flatMap((element) =>
          fields.map(() => (frame ? [42.123456789, 7] : [1, 987.654321])[element] ?? NaN),
        ),
      ),
    ),
  }
  const table = new TableEngine(data, recording)
  const first = await table.query({ filter: '987.654321', sort: null })
  time = 1
  expect((await first.read(0, 10, [0])).rows).toEqual([
    { index: 1, label: 'B', cells: ['987.654321'] },
  ])
  expect(await first.locate(1)).toBe(0)
  const next = await table.query({ filter: '987.654321', sort: null })
  expect(next.total).toBe(0)
  const sorted = await table.query({ filter: '', sort: { column: '@signal:Vm', dir: 'asc' } })
  expect((await sorted.read(0, 10, [0])).rows.map((row) => row.index)).toEqual([1, 0, 2])
  const exact = await table.query({ filter: '42.123456789', sort: null })
  expect((await exact.read(0, 10, [0])).rows.map((row) => row.index)).toEqual([0])
  first.close()
  next.close()
  sorted.close()
  exact.close()
  table.close()
})
