import type { QueryResult } from 'latkit'
import { describe, expect, it } from 'vitest'

import { cell, display, rowsOf } from './cells.js'

describe('native query cells', () => {
  const page: QueryResult = {
    table: 'Device',
    ids: ['a/b', 0],
    total: 2,
    fields: {
      value: Float64Array.of(Math.PI, NaN),
      name: ['one', null],
      enabled: [true, false],
      bus: { reference: 'Bus', ids: [0, null] },
    },
  }
  it('preserves float64 values, native zero IDs, punctuation, and missing values', () => {
    expect(rowsOf(page)).toEqual([
      {
        id: 'a/b',
        entity: { table: 'Device', id: 'a/b' },
        values: { value: Math.PI, name: 'one', enabled: true, bus: { table: 'Bus', id: 0 } },
      },
      {
        id: 0,
        entity: { table: 'Device', id: 0 },
        values: { value: null, name: null, enabled: false, bus: null },
      },
    ])
    expect(cell(page, 'absent', 0)).toBeNull()
  })
  it('formats native references directly without resolving physical row numbers', () => {
    expect(display(cell(page, 'bus', 0), { native: true })).toBe('0')
    expect(display(null)).toBe('—')
    expect(display(false)).toBe('false')
  })
})
