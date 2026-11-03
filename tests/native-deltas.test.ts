import { createRequire } from 'node:module'

import { Data } from 'latkit'
import { beforeAll, expect, it, vi } from 'vitest'

import { Case } from '../src/gridkit/case.js'
import { catalog } from '../src/gridkit/definition.js'
import { deltaProjectionPage } from '../src/gridkit/deltas.js'
import { projectionKey, projectionPage } from '../src/gridkit/projection.js'
import type { ProjectionCursor, ProjectionPage, ProjectionSelection } from '../src/shared/data.js'
import { loadNative } from '../src/workers/native.js'

const signal = AbortSignal.any([])
beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))
const fields: ProjectionSelection[] = [
  { table: 'Bus', fields: ['name', 'params.kv'] },
  { table: 'Branch', fields: ['ports.bus1', 'ports.bus2'] },
]
async function receive(data: Data, next: (cursor?: ProjectionCursor) => Promise<ProjectionPage>) {
  let cursor: ProjectionCursor | undefined
  let bytes = 0
  do {
    const page = await next(cursor)
    data.apply(page.bytes)
    bytes += page.bytes.byteLength
    cursor = page.next
  } while (cursor)
  return bytes
}
function text(count = 6000) {
  return JSON.stringify({
    buses: Array.from({ length: count }, (_, i) => ({
      class: 'Bus',
      number: i,
      name: `Bus ${i}`,
      params: { kv: 100 },
    })),
    devices: [{ class: 'Branch', id: 'line/[]', ports: { bus1: 0, bus2: 1 } }],
  })
}
it('updates one scalar using retained parser parts and native stable IDs', async () => {
  const source = text()
  const before = await Case.parse(source, catalog)
  const after = await Case.revise(before, source.replace('"kv":100', '"kv":230'))
  using data = new Data('case')
  const full = await receive(data, (cursor) =>
    projectionPage(before.projected(), fields, cursor, signal),
  )
  const branches = vi.spyOn(after.projected().tables.get('Branch')!, 'read')
  const buses = vi.spyOn(after.projected().tables.get('Bus')!, 'read')
  const delta = await receive(data, (cursor) =>
    deltaProjectionPage(
      before,
      after,
      fields,
      projectionKey(before.projected(), fields),
      cursor,
      signal,
    ),
  )
  expect(delta).toBeLessThan(full / 100)
  expect(data.get('Bus', 0, 'params.kv')).toBe(230)
  expect(data.get('Bus', 5999, 'params.kv')).toBe(100)
  expect(data.get('Branch', 'line/[]', 'ports.bus1')).toBe(0)
  expect(branches).not.toHaveBeenCalled()
  expect(buses.mock.calls.every(([, , count]) => count === 1)).toBe(true)
  expect(new Set(buses.mock.calls.map(([, offset]) => offset)).size).toBeLessThan(6000)
})
it('adds and removes identities without interpreting row order as identity', async () => {
  const source = text(5)
  const before = await Case.parse(source, catalog)
  const json = JSON.parse(source)
  json.buses = [
    json.buses[4],
    json.buses[1],
    json.buses[0],
    { class: 'Bus', number: 42, name: 'new', params: { kv: 69 } },
  ]
  const after = await Case.revise(before, JSON.stringify(json))
  using data = new Data('case')
  await receive(data, (cursor) => projectionPage(before.projected(), fields, cursor, signal))
  await receive(data, (cursor) =>
    deltaProjectionPage(
      before,
      after,
      fields,
      projectionKey(before.projected(), fields),
      cursor,
      signal,
    ),
  )
  expect(new Set(data.query({ of: 'Bus' }).ids)).toEqual(new Set([0, 1, 4, 42]))
  expect(data.get('Bus', 42, 'params.kv')).toBe(69)
  expect(data.get('Branch', 'line/[]', 'ports.bus2')).toBe(1)
})
it('resets for a different field selection and rejects cancelled pages', async () => {
  const before = await Case.parse(text(2), catalog)
  const after = await Case.revise(before, text(2).replace('"kv":100', '"kv":230'))
  const changed = [{ table: 'Bus', fields: ['params.kv'] }]
  const page = await deltaProjectionPage(
    before,
    after,
    changed,
    projectionKey(before.projected(), fields),
    undefined,
    signal,
  )
  expect(page.base).toBeUndefined()
  const controller = new AbortController()
  controller.abort()
  await expect(
    deltaProjectionPage(
      before,
      after,
      fields,
      projectionKey(before.projected(), fields),
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow()
})
it('refreshes unchanged references when their target identities are added or removed', async () => {
  const source = text(2)
  const before = await Case.parse(source, catalog)
  const json = JSON.parse(source)
  json.buses = json.buses.filter((bus: { number: number }) => bus.number !== 1)
  const removed = await Case.revise(before, JSON.stringify(json))
  using data = new Data('case')
  await receive(data, (cursor) => projectionPage(before.projected(), fields, cursor, signal))
  await receive(data, (cursor) =>
    deltaProjectionPage(
      before,
      removed,
      fields,
      projectionKey(before.projected(), fields),
      cursor,
      signal,
    ),
  )
  expect(data.get('Branch', 'line/[]', 'ports.bus2')).toBeNull()
  const restored = await Case.revise(removed, source)
  await receive(data, (cursor) =>
    deltaProjectionPage(
      removed,
      restored,
      fields,
      projectionKey(removed.projected(), fields),
      cursor,
      signal,
    ),
  )
  expect(data.get('Branch', 'line/[]', 'ports.bus2')).toBe(1)
})
it('declares reference fields even on empty projected tables', async () => {
  const document = await Case.parse(text(2), catalog)
  const empty = document.definition.drawing.blocks.find(
    (block) => !document.projected().tables.get(block.table)!.ids.length,
  )!
  using data = new Data('case')
  const selection = [{ table: empty.table, fields: empty.ports.map(([name]) => name) }]
  await receive(data, (cursor) => projectionPage(document.projected(), selection, cursor, signal))
  const fields = data.describe().tables.find((table) => table.name === empty.table)!.fields
  expect(fields.every((field) => field.kind === 'reference')).toBe(true)
  expect(fields.length).toBe(empty.ports.length)
})
