import { createData, textColumn } from '@latkit/model'
import { expect, it } from 'vitest'

import { coversRows, intersectRows, recordedSelection } from './coverage.js'

const index = { source: 'case', type: 'Bus', version: '1' }
const rows = { kind: 'range' as const, offset: 0, count: 2 }
const base = () =>
  createData(
    {
      axis: { name: 'time' },
      types: {
        Bus: { fields: { x: { type: 'float64' }, Vm: { type: 'float64', sampled: true } } },
      },
    },
    [
      {
        kind: 'rows',
        index,
        rows,
        ids: textColumn(['Bus/1', 'Bus/2']),
        columns: { x: { kind: 'numeric', values: Float64Array.of(0, 1), offset: 0, length: 2 } },
      },
    ],
  )

it('unions IDs and physical selections without silently dropping either', () => {
  const selected = recordedSelection(
    base(),
    [
      { from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1'] } },
      { from: 'Bus', select: ['Vm'], rows: { kind: 'indices', index, values: Uint32Array.of(1) } },
    ],
    'Bus',
    'Vm',
  )
  expect(selected).toMatchObject({ kind: 'range', offset: 0, count: 2, index })
  expect(coversRows([{ kind: 'indices', values: Uint32Array.of(0, 0) }], rows)).toBe(false)
  expect(
    coversRows([{ kind: 'range', offset: 0, count: 10 }], {
      kind: 'indices',
      values: Uint32Array.of(0, 4, 9),
    }),
  ).toBe(true)
})

it('intersects row sets as ranges where they meet in one', () => {
  expect(
    intersectRows(
      { kind: 'range', offset: 0, count: 5 },
      { kind: 'indices', values: Uint32Array.of(3, 4, 7) },
    ),
  ).toEqual({ kind: 'range', offset: 3, count: 2 })
  expect(
    Array.from(
      (
        intersectRows(
          { kind: 'indices', values: Uint32Array.of(1, 3, 5) },
          { kind: 'range', offset: 0, count: 6 },
        ) as { values: Uint32Array }
      ).values,
    ),
  ).toEqual([1, 3, 5])
})
