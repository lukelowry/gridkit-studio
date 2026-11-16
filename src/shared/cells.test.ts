import type { QueryResult } from 'latkit'
import { describe, expect, it } from 'vitest'

import { cell, cellText, changedTable, emptyText, grown, rowsOf, shownColumns } from './cells.js'
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
  it('shows the first columns when none of the chosen ones remain, and none when none were chosen', () => {
    expect(shownColumns(summary, { columns: { Bus: ['vm', 'gone'] } }, 'Bus')).toEqual(['vm'])
    // A case whose fields were renamed still shows a table.
    expect(shownColumns(summary, { columns: { Bus: ['gone', 'renamed'] } }, 'Bus')).toEqual([
      'kv',
      'vm',
    ])
    expect(shownColumns(summary, { columns: { Bus: [] } }, 'Bus')).toEqual([])
    expect(shownColumns(summary, {}, 'Bus')).toEqual(['kv', 'vm'])
  })
  it('writes a whole number out, and any other number to six significant digits', () => {
    expect(cellText(1234567)).toBe('1234567')
    expect(cellText(123456789012)).toBe('123456789012')
    expect(cellText(1.23456789)).toBe('1.23457')
    expect(cellText(0.1 + 0.2)).toBe('0.3')
    expect(cellText(null)).toBe('—')
    expect(cellText({ table: 'Bus', id: 7 })).toBe('7')
  })
  it('says a table is empty only once a page says so', () => {
    const panel = {
      open: true,
      read: true,
      unreadable: false,
      rows: 0,
      loading: false,
      answered: true,
      filtered: false,
    }
    expect(emptyText(panel)).toBe('This case has no elements.')
    expect(emptyText({ ...panel, filtered: true })).toBe('No elements match the filter.')
    // A page that failed, or one still on its way, says nothing about the rows.
    expect(emptyText({ ...panel, answered: false })).toBe('')
    expect(emptyText({ ...panel, loading: true })).toBe('')
    expect(emptyText({ ...panel, rows: 3 })).toBe('')
    expect(emptyText({ ...panel, read: false })).toBe('Loading case…')
    expect(emptyText({ ...panel, read: false, unreadable: true })).toBe('')
    expect(emptyText({ ...panel, open: false })).toBe('Open a GridKit case.')
  })
  it('never narrows a column as other rows scroll into view', () => {
    const widths = grown({}, { name: 120, kv: 40 })
    expect(widths).toEqual({ name: 120, kv: 40 })
    expect(grown(widths, { name: 100, kv: 40 })).toBe(widths)
    expect(grown(widths, { name: 168, kv: 36 })).toEqual({ name: 168, kv: 40 })
  })
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
