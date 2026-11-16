import type { QueryResult } from 'latkit'
import { describe, expect, it } from 'vitest'

import { cell, changedTable, rowsOf } from './cells.js'
import type { Summary } from './messages.js'

describe('the Case panel table', () => {
  const field = (name: string) => ({ name, kind: 'number', label: name }) as const
  const summary = {
    counts: { Bus: 3, Branch: 2 },
    identities: { Bus: 'number', Branch: 'id' },
    definition: {
      tables: [
        { name: 'Bus', label: 'Bus', fields: [field('number'), field('kv'), field('vm')] },
        { name: 'Branch', label: 'Branch', fields: [field('id'), field('r')] },
      ],
    },
  } as unknown as Summary
  const sorted = { type: 'Bus', order: { field: 'kv', direction: 'ascending' as const } }
  it('starts another type unfiltered and unsorted', () => {
    expect(changedTable(summary, { ...sorted, filter: 'a' }, { type: 'Branch' })).toEqual({
      type: 'Branch',
    })
  })
  it('drops a sort or value filter on a column no longer shown, and keeps the others', () => {
    const filtered = { ...sorted, equal: { field: 'vm', value: 1 }, filter: 'a' }
    expect(changedTable(summary, filtered, { columns: { Bus: ['vm'] } })).toEqual({
      type: 'Bus',
      equal: { field: 'vm', value: 1 },
      filter: 'a',
      columns: { Bus: ['vm'] },
    })
    expect(changedTable(summary, filtered, { columns: { Bus: ['kv'] } })).toEqual({
      ...sorted,
      filter: 'a',
      columns: { Bus: ['kv'] },
    })
  })
})

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
})
