import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { Data } from 'latkit'
import { beforeAll, describe, expect, it } from 'vitest'

import { rowsOf } from '../shared/cells.js'
import type { ProjectionCursor } from '../shared/data.js'
import { fieldDefinition, tableDefinition } from '../shared/document.js'
import { loadNative } from '../workers/native.js'
import { Case } from './case.js'
import { type Catalog, catalog, catalogOf } from './definition.js'
import { diagnose } from './issues.js'
import { sourceRange } from './places.js'
import { CaseQueries, projectionPage } from './projection.js'

beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))

const source = `{
 "header": {"case_name": "東京 ⚡"},
 "buses": [
  {"class":"Bus","number":42,"name":"Tokyo 1","params":{"kv":230.000},"extension":{"longitude":-100.00,"latitude":32.5}},
  {"class":"Bus","number":7,"name":"Seven","params":{"kv":115.0}}
 ],
 "signals":[{"signal_id":1,"name":"setpoint 😀"}],
 "devices":[
  {"class":"Branch","id":"line","ports":{"bus1":42,"bus2":7},"unknown":{"keep":1.000}},
  {"class":"ConstantSignalSource","id":"source","ports":{"sr":1}},
  {"class":"GenClassical","id":"fault","ports":{"bus":42,"pmech":1}},
  {"class":"GenClassical","id":"disconnected","ports":{"bus":7}}
 ]
}`
/** The case `text` holds, its bytes read with `read`, as a file of it reads. */
const parse = (text: string, read: Catalog = catalog, signal?: AbortSignal) =>
  Case.parse(new TextEncoder().encode(text), read, 'Case', signal)
describe('single catalog and source ownership', () => {
  it('compiles GridKit metadata and native reference semantics', () => {
    expect(fieldDefinition(catalog.definition, 'GenClassical', 'ports.pmech')).toMatchObject({
      direction: 'in',
      kind: 'reference',
      target: 'Signal',
    })
    expect(catalog.definition.drawing.edges.find((edge) => edge.table === 'Branch')).toEqual({
      table: 'Branch',
      ends: ['ports.bus1', 'ports.bus2'],
      bends: 'extension.polyline',
    })
    expect(
      catalog.definition.drawing.vertices.find((vertex) => vertex.table === 'Bus')?.position,
    ).toEqual(['extension.longitude', 'extension.latitude'])
    expect(catalog.definition.drawing.nets).toContain('Signal')
    expect(
      catalog.definition.drawing.blocks.some((block) => block.table === 'ConstantSignalSource'),
    ).toBe(true)
  })
  it('reads sparse native identities and static values through native queries and patches', async () => {
    const kase = await parse(source)
    const projected = kase.projected()
    const queries = new CaseQueries(projected)
    const data = new Data('case')
    try {
      const page = await queries.page(
        {
          table: 'Bus',
          fields: ['name', 'params.kv', 'extension.longitude'],
          offset: 0,
          limit: 100,
        },
        AbortSignal.any([]),
      )
      expect(rowsOf(page).map((row) => row.id)).toEqual([42, 7])
      expect(rowsOf(page).map((row) => row.values['extension.longitude'])).toEqual([-100, null])
      expect(kase.locate({ table: 'Bus', id: 7 })?.row).toBe(1)
      // Page after page, as a view reads it.
      const selection = [{ table: 'Bus', fields: ['name'] }]
      let cursor: ProjectionCursor | undefined
      do {
        const page = await projectionPage(projected, selection, cursor, AbortSignal.any([]))
        data.apply(page.bytes)
        cursor = page.next
      } while (cursor)
      expect(data.query({ of: 'Bus' }).ids).toEqual([42, 7])
    } finally {
      queries.destroy()
      data.destroy()
    }
  })
  it('places fields in UTF-16 units, and fingerprints what the file holds', async () => {
    const kase = await parse(source)
    const range = sourceRange(kase, { table: 'Signal', id: 1 }, 'name')
    expect(source.slice(range.offset, range.offset + range.length)).toBe('"setpoint 😀"')
    const updated = await parse(source.replace('"kv":115.0', '"kv":138.0'))
    expect(updated.version).not.toBe(kase.version)
    expect((await parse(source)).version).toBe(kase.version)
  })
  it('validates references and preserves linked port locations', async () => {
    const kase = await parse(source)
    expect(
      (await diagnose(kase, AbortSignal.any([]))).filter(({ severity }) => severity === 'error'),
    ).toEqual([])
    const invalid = await parse(source.replace('"bus2":7', '"bus2":999'))
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some(
        (issue) => issue.entity?.table === 'Branch' && issue.entity.id === 'line',
      ),
    ).toBe(true)
  })
  it('rejects duplicate IDs, malformed JSON and cancellation', async () => {
    await expect(parse(source.replace('"number":7', '"number":42'))).rejects.toThrow()
    await expect(parse(source.replace('"kv":115.0', '"kv":115.0,'))).rejects.toThrow()
    await expect(parse(source, catalog, AbortSignal.abort())).rejects.toThrow()
  })
  it('reads JSON alone, and says where a file is not JSON as an editor does', async () => {
    const broken = [
      source.replace('"kv":115.0', '"kv":115.0,'),
      source.replace('"kv":115.0', '"kv":115.0 /* kV */'),
      source.replace('"kv":115.0', '"kv":0115.0'),
      source.replace('"kv":115.0', '"kv":115.'),
      source.replace('"Seven"', '"Sev\ten"'),
      source.replace('"Seven"', '"Sev\\qen"'),
      source.replace('"Seven"', '"Sev\\u00en"'),
      source.replace('"kv":115.0', '"kv":tru'),
    ]
    for (const text of broken) {
      const error = await parse(text).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ message: expect.stringMatching(/^Invalid JSON: /) })
      expect((error as { offset: number }).offset).toBeGreaterThan(0)
    }
    // A key an object repeats, however deep, or that the case does.
    for (const [text, key] of [
      [source.replace('"kv":115.0', '"kv":115.0,"kv":116.0'), 'kv'],
      [source.replace('"line"', '"line","id":"again"'), 'id'],
      [source.replace(/}\s*$/, ',"signals":[]}'), 'signals'],
      // In an object of many keys, found by its hash.
      [
        source.replace(
          '"keep":1.000',
          Array.from({ length: 100 }, (_, i) => `"k${i}":${i}`).join(',') + ',"k50":0',
        ),
        'k50',
      ],
    ] as const)
      await expect(parse(text)).rejects.toThrow('Duplicate JSON property: ' + key)
    // Escapes JSON has read as their text, and a value nests as deep as it is written.
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const kase = await parse(
      source
        .replace('"Seven"', '"Se\\u0076en \\"7\\"\\/\\\\"')
        .replace('"unknown":{"keep":1.000}', `"unknown":${deep}`),
    )
    expect(kase.cell(kase.table('Bus'), 'name', 1)).toBe('Seven "7"/\\')
  })
  it('says where each problem a parse finds is: the record it refuses, or the second of an id', async () => {
    const fault = '{"class":"GenClassical","id":"fault"'
    for (const [text, record, said] of [
      // A bus, a signal and the case are types of their own, never a device's class.
      ...['Bus', 'Signal', 'Case'].map((type) => {
        const named = fault.replace('GenClassical', type)
        return [source.replace(fault, named), named, `${type} is not a device class.`] as const
      }),
      [
        source.replace('"number":7', '"number":42'),
        '{"class":"Bus","number":42,"name":"Seven"',
        'Two rows share the number 42.',
      ],
      [
        source.replace('"id":"disconnected"', '"id":"fault"'),
        '{"class":"GenClassical","id":"fault","ports":{"bus":7}}',
        'Two rows share the id fault.',
      ],
    ] as const) {
      const error = await parse(text).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ code: 'invalid-input', message: said })
      // Where the editor finds the record, in UTF-16 units past the header's characters.
      expect(error).toMatchObject({ offset: text.indexOf(record) })
      expect((error as { length: number }).length).toBeGreaterThan(record.length - 1)
    }
    // Every record it refuses is said where it is, the first first.
    const records = [fault, '{"class":"GenClassical","id":"disconnected"'].map((record) =>
      record.replace('GenClassical', 'Signal'),
    )
    const text = source
      .replace(fault, records[0]!)
      .replace('{"class":"GenClassical","id":"disconnected"', records[1]!)
    const error = await parse(text).catch((reason: unknown) => reason)
    expect((error as { problems: unknown }).problems).toEqual(
      records.map((record) => ({
        message: 'Signal is not a device class.',
        offset: text.indexOf(record),
        length: expect.any(Number),
      })),
    )
  })
  it('reads an integer at either end of its range back as written', async () => {
    for (const value of [-0x8000_0000, 0x7fff_ffff]) {
      const kase = await parse(
        source.replace(
          ']\n}',
          `,\n  {"class":"Esdc1a","id":"exciter","params":{"UEL":${value}}}\n ]\n}`,
        ),
      )
      expect(kase.cell(kase.table('Esdc1a'), 'params.UEL', 0)).toBe(value)
    }
  })
  it('refuses to read into a record nested deeper than the stack holds, as its own problem', async () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const text = source.replace('"unknown":{"keep":1.000}', `"unknown":${deep}`)
    const kase = await parse(text)
    const tooDeep = { code: 'invalid-input', message: expect.stringMatching(/too deeply/) }
    expect(() => sourceRange(kase, { table: 'Branch', id: 'line' }, 'ports.bus1')).toThrow(
      expect.objectContaining(tooDeep),
    )
  })
  it('places the case’s own fields in its header', async () => {
    const kase = await parse(source)
    // A field of the case where it is, as Problems places it.
    const range = sourceRange(kase, { table: 'Case', id: 'case' }, 'header.case_name')
    expect(source.slice(range.offset, range.offset + range.length)).toBe('"東京 ⚡"')
  })
  it('validates the case’s own fields without reading past them', async () => {
    const mistyped = await parse(source.replace('"東京 ⚡"', '7'))
    const issues = await diagnose(mistyped, AbortSignal.any([]))
    expect(issues).toContainEqual(
      expect.objectContaining({
        entity: { table: 'Case', id: 'case' },
        field: 'header.case_name',
        severity: 'error',
      }),
    )
  })
  it('handles native infinite buses and reports invalid known values from the catalog', async () => {
    const kase = await Case.parse(await readFile('cases/TwoBusBasic.case.json'), catalog)
    expect(kase.table('Bus').records.length).toBe(2)
    const invalid = await parse(source.replace('230.000', '1e400'))
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some((issue) => issue.field === 'params.kv'),
    ).toBe(true)
    await expect(parse(source.replace('115.0', '115.0,"kv":116.0'))).rejects.toThrow()
  })
  it('reads a key or a class written with escapes as the name it spells, as JSON does', async () => {
    const escaped = source.replace(
      '{"class":"Branch","id":"line"',
      '{"cl\\u0061ss":"Br\\u0061nch","\\u0069d":"line"',
    )
    const kase = await parse(escaped)
    // A Branch, known by its id, with its ports as a record written plainly has them.
    const branch = kase.table('Branch')
    expect(kase.entity(branch, 0)).toEqual({ table: 'Branch', id: 'line' })
    expect(kase.locate({ table: 'Bus', id: 42 })).not.toBeNull()
    expect(kase.found.some(({ field }) => field.includes('\\'))).toBe(false)
  })
  it('reads a number of the case’s own as a record’s field reads one: finite, or not at all', async () => {
    const kase = await parse(source)
    const field = kase
      .table('Case')
      .shape.fields.find(
        ({ definition, source }) => definition.kind === 'number' && source.kind === 'parameter',
      )!
    const name = field.name.slice(field.name.indexOf('.') + 1)
    const infinite = await parse(
      source.replace('"header":', `"params": {"${name}": 1e400}, "header":`),
    )
    expect(infinite.cell(infinite.table('Case'), field.name, 0)).toBeNull()
    expect(await diagnose(infinite, AbortSignal.any([]))).toContainEqual(
      expect.objectContaining({
        entity: { table: 'Case', id: 'case' },
        field: field.name,
        severity: 'error',
      }),
    )
  })
  it('loads the real TwoArea case', async () => {
    const text = await readFile('cases/TwoArea.case.json', 'utf8')
    const kase = await parse(text)
    expect(kase.table('Bus').records.length).toBe(10)
    expect(kase.tables.get('Branch')).toBeDefined()
    expect(await diagnose(kase, AbortSignal.any([]))).toEqual([])
    expect(fieldDefinition(catalog.definition, 'Ieeet1', 'params.Ispdlim')!.kind).toBe('number')
    // A number written as a boolean, in the first exciter's params.
    const invalid = await parse(text.replace(/"Ispdlim":\s*[-+.\deE]+/, '"Ispdlim": false'))
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some(
        (issue) => issue.field === 'params.Ispdlim',
      ),
    ).toBe(true)
  })
  it('keeps what the catalog does not know: a member as a column, a class as a table', async () => {
    const text = source
      .replace('"devices":[', '"devices":[{"class":"Future","id":"next","params":{"gain":2.5}},')
      .replace('"params":{"kv":115.0}', '"params":{"kv":115.0,"kz":3},"extension":{"vset":1.03}')
    const kase = await parse(text)
    const buses = kase.table('Bus')
    expect(fieldDefinition(kase.definition, 'Bus', 'params.kz')).toMatchObject({ kind: 'number' })
    expect([kase.cell(buses, 'params.kz', 0), kase.cell(buses, 'params.kz', 1)]).toEqual([null, 3])
    // An extension's keys are each tool's own, as GridKit's format has them: one Studio does not
    // know is a column it reads like any other, and nothing to warn of.
    expect(kase.cell(buses, 'extension.vset', 1)).toBe(1.03)
    expect(kase.cell(kase.table('Future'), 'params.gain', 0)).toBe(2.5)
    // An object is kept as its JSON text.
    expect(kase.cell(kase.table('Branch'), 'unknown', 0)).toBe('{"keep":1}')
    expect(
      (await diagnose(kase, AbortSignal.any([]))).map(({ severity, message }) => [
        severity,
        message,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['warning', expect.stringMatching(/^Future is not a class/)],
        ['warning', expect.stringMatching(/^params\.kz is not a Bus field/)],
      ]),
    )
    expect(
      (await diagnose(kase, AbortSignal.any([]))).some(({ field }) => field === 'extension.vset'),
    ).toBe(false)
  })
  it('says a bus name or device id GridKit refuses is an error', async () => {
    const text = source
      .replace('"name":"Seven"', '"name":"Seven/7"')
      .replace('"id":"line"', '"id":"line:1"')
    const kase = await parse(text)
    const said = (await diagnose(kase, AbortSignal.any([])))
      .filter(({ severity }) => severity === 'error')
      .map(({ entity, field, message }) => ({ entity, field, message }))
    const rule = 'only ASCII letters, digits, spaces, _, . and -'
    expect(said).toEqual(
      expect.arrayContaining([
        { entity: { table: 'Bus', id: 7 }, field: 'name', message: `name may contain ${rule}.` },
        { entity: { table: 'Branch', id: 'line:1' }, message: `id may contain ${rule}.` },
      ]),
    )
    // A signal's name is the case's own, which GridKit takes as it is.
    expect(said.some(({ entity }) => entity?.table === 'Signal')).toBe(false)
  })
  it('reads a bus’s class as a field of it, one of the classes its catalog gives', async () => {
    const text = source.replace('"class":"Bus","number":7', '"class":"BusDC","number":7')
    const issues = async (kase: Case) =>
      (await diagnose(kase, AbortSignal.any([]))).map(({ message }) => message)
    const kase = await parse(text)
    const buses = kase.table('Bus')
    expect([kase.cell(buses, 'class', 0), kase.cell(buses, 'class', 1)]).toEqual(['Bus', 'BusDC'])
    expect(await issues(kase)).toContain(
      'BusDC is not a Bus class GridKit Studio knows; it is kept as written.',
    )
    // A catalog that gives the class, as one for a later GridKit would, reads it as any other.
    const bundled = JSON.parse(catalog.text) as { bus: { classes: string[] } }
    const later = catalogOf({
      ...bundled,
      bus: { ...bundled.bus, classes: [...bundled.bus.classes, 'BusDC'] },
    })
    expect((await issues(await parse(text, later))).join()).not.toMatch(/BusDC/)
    // What is no catalog says so, as plainly as GridKit Studio can.
    for (const json of [null, {}, { bus: {}, classes: [] }, { bus: { name: 'Bus' } }])
      expect(() => catalogOf(json)).toThrow('A catalog has a bus and a list of classes.')
  })

  it('numbers a table’s rows by its ids, alike in any revision that keeps them', async () => {
    const indexes = async (text: string) => {
      const kase = await parse(text)
      return (type: string) => kase.projected().tables.get(type)?.ids
    }
    const before = await indexes(source)
    const edited = await indexes(source.replace('"kv":115.0}', '"kv":138.0},"mon":["Vm"]'))
    expect(edited('Bus')).toEqual(before('Bus'))
    expect(edited('Branch')).toEqual(before('Branch'))
    // A table whose ids change, or change order, numbers its rows anew. Another keeps its numbers.
    const [first, second] = [/\{"class":"Bus","number":42.*\},/, /\{"class":"Bus","number":7.*\}/]
    const [one, two] = [source.match(first)![0], source.match(second)![0]]
    const swapped = source
      .replace(first, '@')
      .replace(second, one.slice(0, -1))
      .replace('@', two + ',')
    expect(JSON.parse(swapped).buses.map(({ number }: { number: number }) => number)).toEqual([
      7, 42,
    ])
    const reordered = await indexes(swapped)
    expect(reordered('Bus')).not.toEqual(before('Bus'))
    expect(reordered('Branch')).toEqual(before('Branch'))
    const renamed = await indexes(source.replace('"id":"line"', '"id":"tie"'))
    expect(renamed('Branch')).not.toEqual(before('Branch'))
    expect(renamed('Bus')).toEqual(before('Bus'))
  })

  it('keeps an unknown key that takes a known name, or a point, or holds a null', async () => {
    const text = source
      .replace('"name":"Seven"', '"name":"Seven","Vm":1.0,"spare":null')
      .replace('"name":"Tokyo 1"', '"name":"Tokyo 1","spare":2,"a.b":1.5')
    const kase = await parse(text)
    const fields = Object.fromEntries(
      tableDefinition(kase.definition, 'Bus')!.fields.map((field) => [field.name, field]),
    )
    // The output whose name it takes is named by where it is listed, as for a known key's.
    expect(fields.Vm).toMatchObject({ kind: 'number' })
    expect(fields['mon.Vm']).toMatchObject({ kind: 'sampled', label: 'Vm' })
    // A key with a point is no path through a record key.
    expect(fields['"a.b"']).toMatchObject({ kind: 'number' })
    // A null is a missing value: the column stays a number.
    expect(fields.spare).toMatchObject({ kind: 'number' })
    const buses = kase.table('Bus')
    expect([kase.cell(buses, 'spare', 0), kase.cell(buses, 'spare', 1)]).toEqual([2, null])
  })
})
