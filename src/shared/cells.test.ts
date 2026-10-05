import { type RowsBlock, textColumn } from '@latkit/model'
import { expect, it } from 'vitest'

import { referenceNames, rowsOf } from './cells.js'

it('resolves scalar and list references, honoring offsets and null validity', async () => {
  const index = { source: 'case', version: 'one', type: 'Bus' }
  const blocks: RowsBlock[] = [
    {
      kind: 'rows',
      index: { ...index, type: 'Device' },
      rows: { kind: 'range', offset: 0, count: 2 },
      rowOffset: 0,
      columns: {
        port: {
          kind: 'reference',
          index,
          offset: 1,
          length: 2,
          values: new Uint32Array([99, 1, 88]),
          validity: new Uint8Array([2]),
        },
        ports: {
          kind: 'list',
          offset: 1,
          length: 2,
          offsets: new Int32Array([0, 1, 3, 3]),
          values: {
            kind: 'reference',
            index,
            offset: 0,
            length: 3,
            values: new Uint32Array([99, 2, 3]),
          },
        },
      },
    },
  ]
  const references = await referenceNames(blocks, async (query) => {
    expect(query.rows?.kind).toBe('indices')
    if (query.rows?.kind !== 'indices') throw new Error('indices required')
    expect(Array.from(query.rows.values)).toEqual([1, 2, 3])
    return [
      {
        kind: 'rows',
        index,
        rowOffset: 0,
        rows: { kind: 'indices', values: query.rows.values },
        ids: textColumn(['Bus/2', 'Bus/3', 'Bus/4']),
        columns: {},
      },
    ]
  })
  const rows = rowsOf(blocks, references)
  expect(rows[0]?.values.port).toMatchObject({ id: 'Bus/2' })
  expect(rows[1]?.values.port).toBeNull()
  expect(rows[0]?.values.ports).toMatchObject([{ id: 'Bus/3' }, { id: 'Bus/4' }])
  expect(rows[1]?.values.ports).toEqual([])
})
