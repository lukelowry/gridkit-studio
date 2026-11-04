import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { Data } from 'latkit'
import { beforeAll, expect, it } from 'vitest'

import { Case } from '../src/gridkit/case.js'
import { catalog } from '../src/gridkit/definition.js'
import { projectionPage } from '../src/gridkit/projection.js'
import type { ProjectionCursor } from '../src/shared/data.js'
import { LABEL } from '../src/shared/document.js'
import { loadNative } from '../src/workers/native.js'

beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))

it('opens every bundled case with native identities and lazy scalar projections', async () => {
  for (const file of await readdir('cases')) {
    if (!file.endsWith('.case.json')) continue
    const kase = await Case.parse(await readFile(`cases/${file}`), catalog)
    const projected = kase.projected()
    expect(projected.key).toBe(kase.version)
    for (const [name, table] of projected.tables) {
      const parsed = kase.table(name)
      expect(table.ids.length).toBe(parsed.records.length)
      if (!table.ids.length) continue
      const entity = { table: name, id: table.ids[0]! }
      expect(kase.locate(entity)?.row).toBe(0)
      expect(table.read(LABEL, 0, 1)).toEqual([String(entity.id)])
    }
  }
}, 120_000)

it('declares reference fields even on empty projected tables', async () => {
  const text = JSON.stringify({
    buses: [0, 1].map((number) => ({ class: 'Bus', number, name: `Bus ${number}` })),
    devices: [{ class: 'Branch', id: 'line/[]', ports: { bus1: 0, bus2: 1 } }],
  })
  const document = await Case.parse(new TextEncoder().encode(text), catalog)
  const projected = document.projected()
  // A device type the case has none of, whose ports reference other rows.
  const empty = document.definition.tables.find(
    (table) =>
      !projected.tables.get(table.name)!.ids.length &&
      table.fields.some((field) => field.kind === 'reference'),
  )!
  const ports = empty.fields.filter((field) => field.kind === 'reference').map(({ name }) => name)
  using data = new Data('case')
  const selection = [{ table: empty.name, fields: ports }]
  let cursor: ProjectionCursor | undefined
  do {
    const page = await projectionPage(projected, selection, cursor, AbortSignal.any([]))
    data.apply(page.bytes)
    cursor = page.next
  } while (cursor)
  const fields = data.describe().tables.find((table) => table.name === empty.name)!.fields
  expect(fields.every((field) => field.kind === 'reference')).toBe(true)
  expect(fields.length).toBe(ports.length)
})
