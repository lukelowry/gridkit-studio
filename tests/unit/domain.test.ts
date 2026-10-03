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

import catalogJson from '../../catalog.json'
import { rowsOf } from '../../src/cells.js'
import { Case } from '../../src/gridkit/case.js'
import { catalogOf } from '../../src/gridkit/definition.js'
import { diagnose, editField, sourceRange } from '../../src/gridkit/edits.js'
import { completionsAt } from '../../src/gridkit/navigation.js'
import { parametersOf, selections } from '../../src/gridkit/parameters.js'
import { caseFile, monitorsOf } from '../../src/gridkit/staging.js'
import { diagramOf, networkOf } from '../../src/webview/topology.js'

const catalog = catalogOf(JSON.stringify(catalogJson))
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
  it('derives valid schema, fields, references and simulation options', () => {
    expect(validateSchema(catalog.schema)).toEqual([])
    expect(parametersOf(catalog).tmax.type).toBe('number')
    expect(catalog.schema.types.BusFault.fields['ports.control_signal']).toMatchObject({
      direction: 'in',
      type: { kind: 'reference', to: 'Signal' },
    })
    expect(networkOf(catalog.schema).edges.find((e) => e.type === 'Branch')?.ends).toEqual([
      'bus1',
      'bus2',
    ])
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
        select: ['number', 'name', 'kv'],
        limit: 100,
        ids: true,
        count: true,
      },
      { buffers: 'owned' },
    ))
      blocks.push(block)
    expect(rowsOf(blocks).map((r) => r.id)).toEqual(['Bus/42', 'Bus/7'])
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
    const next = apply(source, editField(kase, 'Bus/7', 'kv', 138))
    expect(next).toContain('"kv":138.0')
    expect(next).toContain('"kv":230.000')
    expect(next).toContain('"keep":1.000')
    expect(JSON.parse(next).buses[0].name).toBe('東京 😀')
    const updated = await Case.parse(next, catalog)
    expect(updated.version).not.toBe(kase.version)
  })
  it('validates references and preserves linked port locations', async () => {
    const kase = await Case.parse(source, catalog)
    expect(diagnose(kase)).toEqual([])
    expect(() => editField(kase, 'Branch/line', 'bus2', 'Bus/99')).toThrow()
    const next = apply(source, editField(kase, 'Branch/line', 'bus2', 'Bus/42'))
    expect(JSON.parse(next).devices[0].ports.bus2).toBe(42)
    const invalid = await Case.parse(source.replace('"bus2":7', '"bus2":999'), catalog)
    expect(diagnose(invalid).some((issue) => issue.id === 'Branch/line')).toBe(true)
  })
  it('rejects duplicate IDs, malformed JSON and cancellation', async () => {
    await expect(Case.parse(source.replace('"number":7', '"number":42'), catalog)).rejects.toThrow()
    await expect(Case.parse(source.replace('"kv":115.0', '"kv":115.0,'), catalog)).rejects.toThrow()
    await expect(Case.parse(source, catalog, 'Case', AbortSignal.abort())).rejects.toThrow()
  })
  it('keeps Server monitor output ordering and all unrelated source bytes', async () => {
    const kase = await Case.parse(source, catalog)
    const fields = selections(kase, [
      { from: 'Bus', select: ['Va', 'Vm'], rows: { kind: 'ids', ids: ['Bus/7'] } },
    ])
    const text = Buffer.concat(caseFile(kase, monitorsOf(kase, fields), null)).toString()
    expect(JSON.parse(text).buses[1].mon).toEqual(['Vm', 'Va'])
    expect(text).toContain('"kv":230.000')
    expect(text).toContain('"keep":1.000')
  })
  it('handles legacy infinite buses and reports invalid known values from the catalog', async () => {
    const kase = await Case.parse(
      await readFile('tests/fixtures/solver/two-bus.case.json', 'utf8'),
      catalog,
    )
    expect(kase.table('Bus').records.length).toBe(2)
    const invalid = await Case.parse(source.replace('230.000', '1e400'), catalog)
    expect(diagnose(invalid).some((issue) => issue.field === 'kv')).toBe(true)
    await expect(Case.parse(source.replace('115.0', '115.0,"kv":116.0'), catalog)).rejects.toThrow()
  })
  it('inserts native real-valued tokens without rewriting unrelated numbers', async () => {
    const text = source.replace('\"kv\":115.0', '')
    const kase = await Case.parse(text, catalog)
    const changed = apply(text, editField(kase, 'Bus/7', 'kv', 138))
    expect(changed).toMatch(/"kv":\s*138\.0/)
    expect(changed).toContain('230.000')
  })
  it('completes catalog fields in incomplete source', () => {
    const text = '{"buses":[{"class":"Bus","number":1,"params":{"k'
    expect(completionsAt(catalog, text, text.length).map((field) => field.name)).toContain('kv')
  })
  it('loads the real TwoArea case', async () => {
    const kase = await Case.parse(
      await readFile('tests/fixtures/TwoArea.case.json', 'utf8'),
      catalog,
    )
    expect(kase.table('Bus').records.length).toBe(10)
    expect(kase.data.tables.Branch).toBeDefined()
  })
})
