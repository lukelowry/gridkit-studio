import { readFile } from 'node:fs/promises'

import {
  createData,
  read,
  type RowsBlock,
  selectBatches,
  staticFields,
  validateSchema,
} from '@latkit/model'
import { describe, expect, it } from 'vitest'

import { rowsOf } from '../shared/cells.js'
import { diagramOf, networkOf, positionOf } from '../shared/schema.js'
import { Case } from './case.js'
import { catalog } from './definition.js'
import { diagnose, editField, sourceRange } from './edits.js'
import { completionsAt } from './navigation.js'

const source = `{
 "header": {"case_name": "東京 ⚡"},
 "buses": [
  {"class":"Bus","number":42,"name":"東京 😀","params":{"kv":230.000},"extension":{"longitude":-100.00,"latitude":32.5}},
  {"class":"Bus","number":7,"name":"Seven","params":{"kv":115.0}}
 ],
 "signals":[{"signal_id":1,"name":"setpoint"}],
 "devices":[
  {"class":"Branch","id":"line","ports":{"bus1":42,"bus2":7},"unknown":{"keep":1.000}},
  {"class":"ConstantSignalSource","id":"source","ports":{"sr":1}},
  {"class":"BusFault","id":"fault","ports":{"bus":42,"control_signal":1}},
  {"class":"BusFault","id":"disconnected","ports":{"bus":7}}
 ]
}`
const apply = (text: string, edits: ReturnType<typeof editField>) =>
  edits
    .sort((a, b) => b.offset - a.offset)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.length),
      text,
    )
describe('single catalog and source ownership', () => {
  it('derives valid schema, fields and references', () => {
    expect(validateSchema(catalog.schema)).toEqual([])
    expect(catalog.schema.types.BusFault.fields['ports.control_signal']).toMatchObject({
      direction: 'in',
      type: { kind: 'reference', to: 'Signal' },
    })
    expect(networkOf(catalog.schema).edges.find((e) => e.type === 'Branch')).toEqual({
      type: 'Branch',
      ends: ['ports.bus1', 'ports.bus2'],
      bends: 'extension.polyline',
    })
    // A bus is placed by its longitude and latitude: two fields, as the case writes them.
    expect(positionOf(catalog.schema, 'Bus')).toEqual({
      x: 'extension.longitude',
      y: 'extension.latitude',
    })
    expect(diagramOf(catalog.schema).edges).toContainEqual({ type: 'Signal' })
    expect(diagramOf(catalog.schema).vertices).toContain('ConstantSignalSource')
  })
  it('reads stable IDs and sparse native identities through current Latkit queries', async () => {
    const kase = await Case.parse(source, catalog)
    const blocks: RowsBlock[] = []
    for await (const block of read(
      kase.data,
      {
        kind: 'rows',
        from: 'Bus',
        select: ['number', 'name', 'params.kv', 'extension.longitude'],
        limit: 100,
        ids: true,
        count: true,
      },
      { buffers: 'owned' },
    ))
      blocks.push(block)
    expect(rowsOf(blocks).map((r) => r.id)).toEqual(['Bus/42', 'Bus/7'])
    expect(rowsOf(blocks).map((r) => r.values['extension.longitude'])).toEqual([-100, null])
    expect(kase.rowOf(kase.table('Bus'), 42)).toBe(0)
    expect(kase.locate('Bus/7')?.row).toBe(1)
    const batches = []
    for await (const batch of selectBatches(kase.data, staticFields(kase.schema), {
      buffers: 'owned',
      maxBlockBytes: 256 * 1024,
    }))
      batches.push(batch)
    expect(createData(kase.schema, structuredClone(batches)).tables.Bus.rows).toEqual(
      kase.data.tables.Bus.rows,
    )
  })
  it('preserves numeric text, unknown properties and UTF-16 source positions', async () => {
    const kase = await Case.parse(source, catalog)
    const range = sourceRange(kase, 'Bus/42', 'name')
    expect(source.slice(range.offset, range.offset + range.length)).toBe('"東京 😀"')
    const next = apply(source, editField(kase, 'Bus/7', 'params.kv', 138))
    expect(next).toContain('"kv":138.0')
    expect(next).toContain('"kv":230.000')
    expect(next).toContain('"keep":1.000')
    expect(JSON.parse(next).buses[0].name).toBe('東京 😀')
    const updated = await Case.parse(next, catalog)
    expect(updated.version).not.toBe(kase.version)
  })
  it('validates references and preserves linked port locations', async () => {
    const kase = await Case.parse(source, catalog)
    expect(diagnose(kase).filter(({ severity }) => severity === 'error')).toEqual([])
    expect(() => editField(kase, 'Branch/line', 'ports.bus2', 'Bus/99')).toThrow()
    const next = apply(source, editField(kase, 'Branch/line', 'ports.bus2', 'Bus/42'))
    expect(JSON.parse(next).devices[0].ports.bus2).toBe(42)
    const invalid = await Case.parse(source.replace('"bus2":7', '"bus2":999'), catalog)
    expect(diagnose(invalid).some((issue) => issue.id === 'Branch/line')).toBe(true)
  })
  it('rejects duplicate IDs, malformed JSON and cancellation', async () => {
    await expect(Case.parse(source.replace('"number":7', '"number":42'), catalog)).rejects.toThrow()
    await expect(Case.parse(source.replace('"kv":115.0', '"kv":115.0,'), catalog)).rejects.toThrow()
    await expect(Case.parse(source, catalog, 'Case', AbortSignal.abort())).rejects.toThrow()
  })
  it('handles native infinite buses and reports invalid known values from the catalog', async () => {
    const kase = await Case.parse(await readFile('cases/TwoBusBasic.case.json', 'utf8'), catalog)
    expect(kase.table('Bus').records.length).toBe(2)
    const invalid = await Case.parse(source.replace('230.000', '1e400'), catalog)
    expect(diagnose(invalid).some((issue) => issue.field === 'params.kv')).toBe(true)
    await expect(Case.parse(source.replace('115.0', '115.0,"kv":116.0'), catalog)).rejects.toThrow()
  })
  it('inserts native real-valued tokens without rewriting unrelated numbers', async () => {
    const text = source.replace('\"kv\":115.0', '')
    const kase = await Case.parse(text, catalog)
    const changed = apply(text, editField(kase, 'Bus/7', 'params.kv', 138))
    expect(changed).toMatch(/"kv":\s*138\.0/)
    expect(changed).toContain('230.000')
  })
  it('completes catalog fields in incomplete source', () => {
    const text = '{"buses":[{"class":"Bus","number":1,"params":{"k'
    expect(completionsAt(catalog, text, text.length).map((field) => field.name)).toContain('kv')
  })
  it('loads the real TwoArea case', async () => {
    const kase = await Case.parse(await readFile('cases/TwoArea.case.json', 'utf8'), catalog)
    expect(kase.table('Bus').records.length).toBe(10)
    expect(kase.data.tables.Branch).toBeDefined()
    expect(diagnose(kase)).toEqual([])
    expect(catalog.schema.types.Ieeet1.fields['params.Ispdlim']!.type).toBe('float64')
    const id = kase.id(kase.table('Ieeet1'), 0)
    const changed = apply(
      new TextDecoder().decode(kase.file),
      editField(kase, id, 'params.Ispdlim', 1),
    )
    expect(changed).toMatch(/"Ispdlim":\s*1\.0/)
    const invalid = await Case.parse(
      changed.replace(/"Ispdlim":\s*1\.0/, '"Ispdlim":false'),
      catalog,
    )
    expect(diagnose(invalid).some((issue) => issue.field === 'params.Ispdlim')).toBe(true)
  })
  it('keeps what the catalog does not know: a member as a column, a class as a table', async () => {
    const text = source
      .replace('"devices":[', '"devices":[{"class":"Future","id":"next","params":{"gain":2.5}},')
      .replace('"params":{"kv":115.0}', '"params":{"kv":115.0,"kz":3}')
    const kase = await Case.parse(text, catalog)
    const buses = kase.table('Bus')
    expect(kase.schema.types.Bus!.fields['params.kz']).toMatchObject({ type: 'float64' })
    expect([kase.cell(buses, 'params.kz', 0), kase.cell(buses, 'params.kz', 1)]).toEqual([null, 3])
    expect(kase.cell(kase.table('Future'), 'params.gain', 0)).toBe(2.5)
    // An object is kept as its JSON text, and not edited in place.
    expect(kase.cell(kase.table('Branch'), 'unknown', 0)).toBe('{"keep":1}')
    expect(() => editField(kase, 'Branch/line', 'unknown', '{}')).toThrow()
    expect(diagnose(kase).map(({ severity, message }) => [severity, message])).toEqual(
      expect.arrayContaining([
        ['warning', expect.stringMatching(/^Future is not a class/)],
        ['warning', expect.stringMatching(/^params\.kz is not a Bus field/)],
      ]),
    )
    const next = apply(text, editField(kase, 'Bus/7', 'params.kz', 4))
    expect(JSON.parse(next).buses[1].params.kz).toBe(4)
  })
})
