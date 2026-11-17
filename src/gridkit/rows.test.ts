import { createRequire } from 'node:module'

import { Data, reference } from 'latkit'
import { beforeAll, expect, it } from 'vitest'

import { rowsOf } from '../shared/cells.js'
import { type CaseRowsCursor, type FieldSelection, PAGE_BYTES } from '../shared/data.js'
import { loadNative } from '../workers/native.js'
import { Case } from './case.js'
import { catalog } from './definition.js'
import type { CaseColumns } from './document.js'
import { CaseQueries, caseRowsPage } from './rows.js'

const signal = AbortSignal.any([])

beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))

const document: CaseColumns = {
  key: 'revision-1',
  definition: {
    tables: [
      {
        name: 'Bus',
        label: 'Bus',
        labelField: '@studio.label',
        fields: [
          { name: '@studio.label', kind: 'text', label: 'Name' },
          { name: 'v', kind: 'number', label: 'Voltage' },
        ],
      },
      {
        name: 'Device',
        label: 'Device',
        labelField: 'id',
        fields: [{ name: 'bus', kind: 'reference', label: 'Bus', target: 'Bus' }],
      },
    ],
    drawing: { geographic: false, vertices: [], edges: [] },
  },
  tables: new Map([
    [
      'Bus',
      {
        ids: [1, 2],
        read: (name: string, offset: number, count: number) =>
          (name === 'v' ? Float64Array.of(Math.PI, 2) : ['North', 'South']).slice(
            offset,
            offset + count,
          ),
      },
    ],
    ['Device', { ids: ['a/b'], read: () => reference('Bus', [2]) }],
  ]),
}

/** Parses `text` and returns the columns views read. */
const caseColumns = async (text: string) =>
  (await Case.parse(new TextEncoder().encode(text), catalog)).columns()

/** Applies every page of `selection` to `data`, as a view does, and returns the page count. */
async function loadPages(
  data: Data,
  document: CaseColumns,
  selection: readonly FieldSelection[],
): Promise<number> {
  let pages = 0
  let cursor: CaseRowsCursor | undefined
  do {
    const page = await caseRowsPage(document, selection, cursor, signal)
    data.apply(page.bytes)
    cursor = page.next
    pages++
  } while (cursor)
  return pages
}

it('projects reference identities before fields and queries lazily', async () => {
  using data = new Data('case')
  await loadPages(data, document, [{ table: 'Device', fields: ['bus'] }])
  expect(data.get('Device', 'a/b', 'bus')).toEqual(2)
  expect(data.query({ of: 'Bus' }).ids).toEqual([1, 2])
  const queries = new CaseQueries(document)
  try {
    const page = await queries.page(
      { table: 'Bus', fields: ['v'], offset: 0, limit: 1, search: 'North' },
      signal,
    )
    expect(page.total).toBe(1)
    expect(page.fields.v).toEqual(Float64Array.of(Math.PI))
  } finally {
    queries.destroy()
  }
  await expect(
    caseRowsPage(document, [{ table: 'Bus', fields: ['missing'] }], undefined, signal),
  ).rejects.toThrow('Unknown field')
})

it('orders a text column itself, since a query sorts only numbers', async () => {
  const names = ['bus 10', 'Bus 9', '', 'alpha', 'bus 10']
  const ids = [5, 4, 3, 2, 1]
  const texts: CaseColumns = {
    key: 'texts',
    definition: {
      tables: [
        {
          name: 'Bus',
          label: 'Bus',
          labelField: 'name',
          fields: [
            { name: '@studio.label', kind: 'text', label: 'Label' },
            { name: 'name', kind: 'text', label: 'Name' },
            { name: 'v', kind: 'number', label: 'Voltage' },
          ],
        },
      ],
      drawing: { geographic: false, vertices: [], edges: [] },
    },
    tables: new Map([
      [
        'Bus',
        {
          ids,
          read: (name: string, offset: number, count: number) =>
            (name === 'v'
              ? Float64Array.of(1, 2, 3, 4, 5)
              : name === 'name'
                ? names
                : ids.map(String)
            ).slice(offset, offset + count),
        },
      ],
    ]),
  }
  const queries = new CaseQueries(texts)
  try {
    const page = (request: Partial<Parameters<CaseQueries['page']>[0]>) =>
      queries.page({ table: 'Bus', fields: ['name'], offset: 0, limit: 10, ...request }, signal)
    const ascending = { field: 'name', direction: 'ascending' } as const
    const descending = { field: 'name', direction: 'descending' } as const
    // Letters without regard to case and digits by value. Equal names keep their order, and a row
    // without a name comes last either way.
    expect((await page({ order: ascending })).ids).toEqual([2, 4, 5, 1, 3])
    expect((await page({ order: descending })).ids).toEqual([5, 1, 4, 2, 3])
    const second = await page({ order: ascending, offset: 1, limit: 2 })
    expect(second.ids).toEqual([4, 5])
    expect(second.total).toBe(5)
    // The filter, the rows asked for and an anchor all follow that order.
    expect((await page({ order: descending, search: 'us 1' })).ids).toEqual([5, 1])
    expect((await page({ order: ascending, ids: [1, 2] })).ids).toEqual([2, 1])
    expect(await page({ order: ascending, anchor: 1 })).toMatchObject({ anchored: true, offset: 0 })
    // A number column is still sorted by the query.
    expect((await page({ order: { field: 'v', direction: 'descending' } })).ids).toEqual([
      1, 2, 3, 4, 5,
    ])
  } finally {
    queries.destroy()
  }
})

it('queries typed fields in empty tables', async () => {
  const empty: CaseColumns = {
    ...document,
    tables: new Map([
      ['Bus', { ids: [], read: (name: string) => (name === 'v' ? new Float64Array() : []) }],
      ['Device', { ids: [], read: () => reference('Bus', []) }],
    ]),
  }
  const queries = new CaseQueries(empty)
  try {
    const page = await queries.page({ table: 'Bus', fields: ['v'], offset: 0, limit: 10 }, signal)
    expect(page.ids).toEqual([])
    expect(page.total).toBe(0)
    expect(page.fields.v).toEqual(new Float64Array())
    const references = await queries.page(
      { table: 'Device', fields: ['bus'], offset: 0, limit: 10 },
      signal,
    )
    expect(references.fields.bus).toEqual({ reference: 'Bus', ids: [] })
  } finally {
    queries.destroy()
  }
})

/** A table of `rows` buses with `note`, a voltage decreasing by row, and an odd or even label. */
const buses = (rows: number, note = ''): CaseColumns => ({
  key: 'revision-1',
  definition: {
    tables: [
      {
        name: 'Bus',
        label: 'Bus',
        labelField: '@studio.label',
        fields: [
          { name: '@studio.label', kind: 'text', label: 'Name' },
          { name: 'note', kind: 'text', label: 'Note' },
          { name: 'v', kind: 'number', label: 'Voltage' },
        ],
      },
    ],
    drawing: { geographic: false, vertices: [], edges: [] },
  },
  tables: new Map([
    [
      'Bus',
      {
        ids: Array.from({ length: rows }, (_, row) => row),
        read: (name: string, offset: number, count: number) =>
          name === 'v'
            ? Float64Array.from({ length: count }, (_, at) => -(offset + at))
            : Array.from({ length: count }, (_, at) =>
                name === 'note' ? note : (offset + at) % 2 ? 'odd' : 'even',
              ),
      },
    ],
  ]),
})

it('shows an anchored page among the rows its request keeps, in its order', async () => {
  const queries = new CaseQueries(buses(100))
  try {
    const request = {
      table: 'Bus',
      fields: ['v'],
      offset: 3,
      limit: 30,
      search: 'odd',
      order: { field: 'v', direction: 'ascending' },
    } as const
    // Odd rows, highest id first, with the anchor a few rows down the page.
    const page = await queries.page({ ...request, anchor: 51 }, signal)
    expect(page.anchored).toBe(true)
    expect(page.ids.slice(0, 3)).toEqual([71, 69, 67])
    expect(page.ids.indexOf(51)).toBeGreaterThan(0)
    expect(page.ids.indexOf(51)).toBeLessThan(request.limit)
    // An anchor the request filters out falls back to the requested page and reports it.
    const left = await queries.page({ ...request, anchor: 50 }, signal)
    expect(left).toMatchObject({ anchored: false, offset: request.offset })
    expect(left.ids[0]).toBe(99 - 2 * request.offset)
    // A page without an anchor has no `anchored` property.
    expect(await queries.page(request, signal)).not.toHaveProperty('anchored')
  } finally {
    queries.destroy()
  }
})

it('sends a table heavier than a page in pages that each fit, sized from the one before', async () => {
  const rows = 3000
  const note = 'x'.repeat(4096)
  const document = buses(rows, note)
  using data = new Data('case')
  const sizes: number[] = []
  let cursor: CaseRowsCursor | undefined
  do {
    const page = await caseRowsPage(document, [{ table: 'Bus', fields: ['note'] }], cursor, signal)
    data.apply(page.bytes)
    sizes.push(page.bytes.byteLength)
    cursor = page.next
  } while (cursor)
  expect(Math.max(...sizes)).toBeLessThanOrEqual(PAGE_BYTES)
  // About as few pages as the bytes require, with every row's note present.
  expect(sizes.length).toBeLessThan((2 * rows * note.length) / PAGE_BYTES + 2)
  expect(data.get('Bus', rows - 1, 'note')).toBe(note)
})

it('reads a column whose first rows are empty, past one load step', async () => {
  // More rows than one load step, where only the last few have a note.
  const rows = 10_000
  const noted = rows - 3
  const table: CaseColumns = {
    key: 'revision-1',
    definition: {
      tables: [
        {
          name: 'Bus',
          label: 'Bus',
          labelField: '@studio.label',
          fields: [
            { name: '@studio.label', kind: 'text', label: 'Name' },
            { name: 'note', kind: 'text', label: 'Note' },
            { name: 'v', kind: 'number', label: 'Voltage' },
          ],
        },
      ],
      drawing: { geographic: false, vertices: [], edges: [] },
    },
    tables: new Map([
      [
        'Bus',
        {
          ids: Array.from({ length: rows }, (_, row) => row),
          read: (name: string, offset: number, count: number) =>
            name === 'v'
              ? Float64Array.from({ length: count }, (_, at) => -(offset + at))
              : Array.from({ length: count }, (_, at) =>
                  name === 'note' ? (offset + at < noted ? null : 'late') : String(offset + at),
                ),
        },
      ],
    ]),
  }
  const queries = new CaseQueries(table)
  try {
    const page = await queries.page(
      {
        table: 'Bus',
        fields: ['note', 'v'],
        offset: 1,
        limit: 1,
        equal: { field: 'note', value: 'late' },
        order: { field: 'v', direction: 'ascending' },
      },
      signal,
    )
    // The matching rows in order, and the page is the second of them.
    expect(page.total).toBe(rows - noted)
    expect(page.ids).toEqual([rows - 2])
    expect(page.fields.note).toEqual(['late'])
    const first = await queries.page(
      { table: 'Bus', fields: ['note'], offset: noted - 1, limit: 2 },
      signal,
    )
    expect(first.fields.note).toEqual([null, 'late'])
  } finally {
    queries.destroy()
  }
})

it('reads sparse native identities and static values through native queries and patches', async () => {
  const document = await caseColumns(`{
 "buses": [
  {"class":"Bus","number":42,"name":"Tokyo 1","params":{"kv":230.000},"extension":{"longitude":-100.00,"latitude":32.5}},
  {"class":"Bus","number":7,"name":"Seven","params":{"kv":115.0}}
 ]
}`)
  const queries = new CaseQueries(document)
  using data = new Data('case')
  try {
    const page = await queries.page(
      {
        table: 'Bus',
        fields: ['name', 'params.kv', 'extension.longitude'],
        offset: 0,
        limit: 100,
      },
      signal,
    )
    expect(rowsOf(page).map((row) => row.id)).toEqual([42, 7])
    expect(rowsOf(page).map((row) => row.values['extension.longitude'])).toEqual([-100, null])
    await loadPages(data, document, [{ table: 'Bus', fields: ['name'] }])
    expect(data.query({ of: 'Bus' }).ids).toEqual([42, 7])
  } finally {
    queries.destroy()
  }
})

it('sends a view each table whole, in few pages however many its rows', async () => {
  const buses = Array.from({ length: 10_000 }, (_, at) => ({
    class: 'Bus',
    number: at + 1,
    name: 'Bus ' + (at + 1),
  }))
  const document = await caseColumns(JSON.stringify({ buses }))
  using data = new Data('case')
  // Ids, then names, in far fewer pages than rows.
  expect(await loadPages(data, document, [{ table: 'Bus', fields: ['name'] }])).toBeLessThan(10)
  expect(data.query({ of: 'Bus' }).ids).toHaveLength(buses.length)
  expect(data.get('Bus', buses.length, 'name')).toBe('Bus ' + buses.length)
})

it('declares reference fields even on empty columns tables', async () => {
  const text = JSON.stringify({
    buses: [0, 1].map((number) => ({ class: 'Bus', number, name: `Bus ${number}` })),
    devices: [{ class: 'Branch', id: 'line/[]', ports: { bus1: 0, bus2: 1 } }],
  })
  const document = await caseColumns(text)
  // A device type with no records whose ports reference other rows.
  const empty = document.definition.tables.find(
    (table) =>
      !document.tables.get(table.name)!.ids.length &&
      table.fields.some((field) => field.kind === 'reference'),
  )!
  const ports = empty.fields.filter((field) => field.kind === 'reference').map(({ name }) => name)
  using data = new Data('case')
  await loadPages(data, document, [{ table: empty.name, fields: ports }])
  const fields = data.describe().tables.find((table) => table.name === empty.name)!.fields
  expect(fields.every((field) => field.kind === 'reference')).toBe(true)
  expect(fields.length).toBe(ports.length)
})
