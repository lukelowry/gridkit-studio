import { createRequire } from 'node:module'

import { Data, reference } from 'latkit'
import { beforeAll, expect, it } from 'vitest'

import { rowsOf } from '../shared/cells.js'
import type { ProjectionCursor, ProjectionSelection } from '../shared/data.js'
import { loadNative } from '../workers/native.js'
import { Case } from './case.js'
import { catalog } from './definition.js'
import type { ProjectedDocument } from './document.js'
import { CaseQueries, projectionPage } from './projection.js'

const signal = AbortSignal.any([])

beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))

const document: ProjectedDocument = {
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

/** The case `text` holds, as views project it. */
const projected = async (text: string) =>
  (await Case.parse(new TextEncoder().encode(text), catalog)).projected()

/** `selection` of `document` in `data`, page after page, as a view reads it; how many pages. */
async function project(
  data: Data,
  document: ProjectedDocument,
  selection: readonly ProjectionSelection[],
): Promise<number> {
  let pages = 0
  let cursor: ProjectionCursor | undefined
  do {
    const page = await projectionPage(document, selection, cursor, signal)
    data.apply(page.bytes)
    cursor = page.next
    pages++
  } while (cursor)
  return pages
}

it('projects reference identities before fields and queries lazily', async () => {
  using data = new Data('case')
  await project(data, document, [{ table: 'Device', fields: ['bus'] }])
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
    projectionPage(document, [{ table: 'Bus', fields: ['missing'] }], undefined, signal),
  ).rejects.toThrow('Unknown field')
})

it('queries typed fields in empty tables and rejects filtered source-order anchors', async () => {
  const empty: ProjectedDocument = {
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
    await expect(
      queries.page(
        { table: 'Bus', fields: ['v'], offset: 0, limit: 10, anchor: 1, search: 'A' },
        signal,
      ),
    ).rejects.toThrow('source order')
  } finally {
    queries.destroy()
  }
})

it('reads a column whose first rows hold nothing, past what the panel loads at a time', async () => {
  // More rows than a table's columns load in at once, the first of them all without a note.
  const rows = 10_000
  const noted = rows - 3
  const table: ProjectedDocument = {
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
    // The rows that hold it, in order, of which the page is the second.
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
  const document = await projected(`{
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
    await project(data, document, [{ table: 'Bus', fields: ['name'] }])
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
  const document = await projected(JSON.stringify({ buses }))
  using data = new Data('case')
  // Its identities, then its names: far fewer pages than it has rows.
  expect(await project(data, document, [{ table: 'Bus', fields: ['name'] }])).toBeLessThan(10)
  expect(data.query({ of: 'Bus' }).ids).toHaveLength(buses.length)
  expect(data.get('Bus', buses.length, 'name')).toBe('Bus ' + buses.length)
})

it('declares reference fields even on empty projected tables', async () => {
  const text = JSON.stringify({
    buses: [0, 1].map((number) => ({ class: 'Bus', number, name: `Bus ${number}` })),
    devices: [{ class: 'Branch', id: 'line/[]', ports: { bus1: 0, bus2: 1 } }],
  })
  const document = await projected(text)
  // A device type the case has none of, whose ports reference other rows.
  const empty = document.definition.tables.find(
    (table) =>
      !document.tables.get(table.name)!.ids.length &&
      table.fields.some((field) => field.kind === 'reference'),
  )!
  const ports = empty.fields.filter((field) => field.kind === 'reference').map(({ name }) => name)
  using data = new Data('case')
  await project(data, document, [{ table: empty.name, fields: ports }])
  const fields = data.describe().tables.find((table) => table.name === empty.name)!.fields
  expect(fields.every((field) => field.kind === 'reference')).toBe(true)
  expect(fields.length).toBe(ports.length)
})
