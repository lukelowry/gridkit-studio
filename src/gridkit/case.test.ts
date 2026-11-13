import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { type Entity, fieldDefinition, tableDefinition } from '../shared/document.js'
import { Case, versionOf } from './case.js'
import { CHUNK_ROWS } from './columns.js'
import { type Catalog, catalog, catalogOf } from './definition.js'
import { diagnose } from './issues.js'
import { sourceRange } from './places.js'

const source = `{
 "header": {"case_name": "東京 ⚡", "case_description": "", "case_comments": ""},
 "params": {"freq_base": 60.0, "va_base": 100e6},
 "buses": [
  {"class":"Bus","number":42,"name":"Tokyo 1","params":{"kv":230.000},"extension":{"longitude":-100.00,"latitude":32.5}},
  {"class":"Bus","number":7,"name":"Seven","params":{"kv":115.0}}
 ],
 "signals":[{"signal_id":1,"name":"setpoint 😀"}],
 "devices":[
  {"class":"Branch","id":"line","params":{},"ports":{"bus1":42,"bus2":7},"unknown":{"keep":1.000}},
  {"class":"ConstantSignalSource","id":"source","params":{},"ports":{"sr":1}},
  {"class":"GenClassical","id":"fault","params":{},"ports":{"bus":42,"pmech":1}},
  {"class":"GenClassical","id":"disconnected","params":{},"ports":{"bus":7}}
 ]
}`
/** The case `text` holds, its bytes read with `read`, as a file of it reads. */
const parse = (text: string, read: Catalog = catalog) =>
  Case.parse(new TextEncoder().encode(text), read)
/** What is wrong with `kase`, each issue as its severity and what it says. */
const said = async (kase: Case) =>
  (await diagnose(kase, AbortSignal.any([]))).map(({ severity, message }) => [severity, message])
/** The text of `text` where `kase`, read from it, places the element `id`, or its `field`. */
const placed = (kase: Case, text: string, id: Entity, field?: string) => {
  const { offset, length } = sourceRange(kase, id, field)
  return text.slice(offset, offset + length)
}

describe('single catalog and source ownership', () => {
  it('compiles GridKit metadata and native reference semantics', () => {
    expect(fieldDefinition(catalog.definition, 'GenClassical', 'ports.pmech')).toMatchObject({
      kind: 'reference',
      target: 'Signal',
    })
    expect(
      catalog.shapes.get('GenClassical')!.ports.find(({ name }) => name === 'ports.pmech'),
    ).toMatchObject({ direction: 'in' })
    expect(catalog.definition.drawing.edges.find((edge) => edge.table === 'Branch')).toEqual({
      table: 'Branch',
      ends: ['ports.bus1', 'ports.bus2'],
      bends: 'extension.polyline',
    })
    expect(
      catalog.definition.drawing.vertices.find((vertex) => vertex.table === 'Bus')?.position,
    ).toEqual(['extension.longitude', 'extension.latitude'])
  })
  it('places fields in UTF-16 units, and fingerprints what the file holds as its catalog reads it', async () => {
    const kase = await parse(source)
    expect(placed(kase, source, { table: 'Signal', id: 1 }, 'name')).toBe('"setpoint 😀"')
    const updated = await parse(source.replace('"kv":115.0', '"kv":138.0'))
    expect(updated.version).not.toBe(kase.version)
    expect((await parse(source)).version).toBe(kase.version)
    // Its bytes alone say it, before any of them is read as a case.
    expect(versionOf(catalog, new TextEncoder().encode(source))).toBe(kase.version)
    // The same file read with another catalog is other content.
    const revised = catalogOf({ ...JSON.parse(catalog.text), revision: 2 })
    expect((await parse(source, revised)).version).not.toBe(kase.version)
  })
  it('validates references and preserves linked port locations', async () => {
    const kase = await parse(source)
    expect((await said(kase)).filter(([severity]) => severity === 'error')).toEqual([])
    const invalid = await parse(source.replace('"bus2":7', '"bus2":999'))
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some(
        (issue) => issue.entity?.table === 'Branch' && issue.entity.id === 'line',
      ),
    ).toBe(true)
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
    // Escapes JSON has read as their text, and a value nests as deep as it is written: what is
    // beside it in its record is read, and placed, all the same.
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const text = source
      .replace('"Seven"', '"Se\\u0076en \\"7\\"\\/\\\\"')
      .replace('"unknown":{"keep":1.000}', `"unknown":${deep}`)
    const kase = await parse(text)
    expect(kase.cell(kase.table('Bus'), 'name', 1)).toBe('Seven "7"/\\')
    expect(placed(kase, text, { table: 'Branch', id: 'line' }, 'ports.bus1')).toBe('42')
  })
  it('says where each problem a parse finds is: the record it refuses, or the second of an id', async () => {
    const fault = '{"class":"GenClassical","id":"fault"'
    for (const [text, record, told] of [
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
        '{"class":"GenClassical","id":"fault","params":{},"ports":{"bus":7}}',
        'Two rows share the id fault.',
      ],
    ] as const) {
      const error = await parse(text).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ code: 'invalid-input', message: told })
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
  it('reads an integer as GridKit does: a whole number written as one, to either end of its range', async () => {
    const exciter = (value: string) =>
      parse(
        source.replace(
          ']\n}',
          `,\n  {"class":"Esdc1a","id":"exciter","params":{"UEL":${value}},"ports":{}}\n ]\n}`,
        ),
      )
    for (const value of [-0x8000_0000, 0x7fff_ffff]) {
      const kase = await exciter(String(value))
      expect(kase.cell(kase.table('Esdc1a'), 'params.UEL', 0)).toBe(value)
    }
    // A fraction or an exponent makes it a real, which GridKit refuses for an integer.
    for (const real of ['1.0', '1e0', '2.5']) {
      const kase = await exciter(real)
      expect(kase.cell(kase.table('Esdc1a'), 'params.UEL', 0)).toBeNull()
      expect(await said(kase)).toContainEqual(['error', 'Invalid params.UEL value.'])
    }
  })
  it('reads each number as the double nearest what is written, however many digits it has', async () => {
    const numbers = [
      ...['0', '-0', '1e0', '1E5', '1e-5', '0.1', '230.000', '0.30000000000000004'],
      // Fifteen digits, sixteen, and more than a double holds.
      ...['123456789012345', '1234567890123456', '12345678901234567', '0.1234567890123456789'],
      // About the largest whole number a double holds exactly, and the powers of ten it takes.
      ...['9007199254740991', '9007199254740992', '9007199254740993', '90071992547409.93'],
      ...['8.41e21', '1e22', '1e23', '7e22', '0.07e24', '123.456e-7', '6.0221409e+23'],
      ...['4503599627370496.5', '4503599627370497.5', '1.0000000000000002', '72057594037927945'],
      ...['1.7976931348623157e308', '5e-324', '2.2250738585072014e-308', '100000000000000000000'],
      ...['0.000001', '0.0000000000000000000000001234567890123456789', '-1.5e+3', '-0.0'],
    ]
    const kase = await parse(
      JSON.stringify({ buses: numbers.map((_, at) => ({ class: 'Bus', number: at })) }).replace(
        /"number":(\d+)/g,
        (_, at: string) =>
          `"number":${at},"params":{"kv":${numbers[Number(at)]}},"spare":${numbers[Number(at)]}`,
      ),
    )
    const buses = kase.table('Bus')
    for (const [row, written] of numbers.entries()) {
      // A field the catalog knows, and one it does not, read alike. Negative zero keeps its sign.
      expect(Object.is(kase.cell(buses, 'params.kv', row), Number(written))).toBe(true)
      expect(Object.is(kase.cell(buses, 'spare', row), Number(written))).toBe(true)
    }
  })
  it('places the case’s own fields in its header', async () => {
    const kase = await parse(source)
    // A field of the case where it is, as Problems places it.
    expect(placed(kase, source, { table: 'Case', id: 'case' }, 'header.case_name')).toBe(
      '"東京 ⚡"',
    )
    expect(placed(kase, source, { table: 'Case', id: 'case' }, 'params.va_base')).toBe('100e6')
    // The case's own row stands in its header, and a field it does not write at the header's start.
    const header = JSON.stringify(JSON.parse(source).header)
    expect(JSON.parse(placed(kase, source, { table: 'Case', id: 'case' }))).toEqual(
      JSON.parse(header),
    )
    expect(placed(kase, source, { table: 'Case', id: 'case' }, 'header.case_date_time')).toBe('{')
    // With no header, the row is the file's first character.
    const bare = await parse(JSON.stringify({ buses: [] }))
    expect(sourceRange(bare, { table: 'Case', id: 'case' })).toEqual({ offset: 0, length: 1 })
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
  it('says what GridKit refuses a case without: each member its parser requires', async () => {
    // A record that writes them all says nothing, whatever else it leaves out.
    expect(await said(await parse(source))).toEqual([
      ['warning', expect.stringMatching(/^unknown is not a Branch field/)],
    ])
    const lacking = `{
 "header": {"case_name": "bare"},
 "buses": [{"number":1}, {"class":"Bus","number":2,"name":"two","params":null}],
 "signals": [{"signal_id":1}],
 "devices": [{"class":"Branch","id":"line"}, {"class":"Future","id":"next"}]
}`
    const kase = await parse(lacking)
    const errors = (await diagnose(kase, AbortSignal.any([])))
      .filter(({ severity }) => severity === 'error')
      .map(({ entity, field, message, offset, length }) => ({
        entity,
        ...(field && { field }),
        message,
        at: lacking.slice(offset, offset + length),
      }))
    const own = { table: 'Case', id: 'case' }
    expect(errors).toEqual(
      expect.arrayContaining([
        // What a record must write is said where the record begins.
        { entity: own, message: 'The case has no params.', at: '{' },
        ...['header.case_description', 'header.case_comments'].map((field) => ({
          entity: own,
          field,
          message: `Missing or invalid ${field} value.`,
          at: '{',
        })),
        ...['params.freq_base', 'params.va_base'].map((field) => ({
          entity: own,
          field,
          message: `Missing or invalid ${field} value.`,
          at: '{',
        })),
        { entity: { table: 'Bus', id: 1 }, message: 'A Bus record has no params.', at: '{' },
        ...['name', 'class'].map((field) => ({
          entity: { table: 'Bus', id: 1 },
          field,
          message: `Missing or invalid ${field} value.`,
          at: '{',
        })),
        {
          entity: { table: 'Signal', id: 1 },
          field: 'name',
          message: 'Missing or invalid name value.',
          at: '{',
        },
        ...['params', 'ports'].map((member) => ({
          entity: { table: 'Branch', id: 'line' },
          message: `A Branch record has no ${member}.`,
          at: '{',
        })),
      ]),
    )
    // A member written, whatever it holds, is written; a class GridKit Studio does not know is
    // said to be one, and nothing more of its records.
    expect(errors.some(({ entity }) => entity?.id === 2 || entity?.table === 'Future')).toBe(false)
    expect(errors.some(({ message }) => /has no (header|buses|devices)/.test(message))).toBe(false)
    // A case without its arrays is told so, as one without its header is.
    const empty = await parse('{}')
    expect(await said(empty)).toEqual(
      expect.arrayContaining(
        ['header', 'params', 'buses', 'devices'].map((member) => [
          'error',
          `The case has no ${member}.`,
        ]),
      ),
    )
  })
  it('says a value its field cannot read is invalid', async () => {
    const invalid = await parse(source.replace('230.000', '1e400'))
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some((issue) => issue.field === 'params.kv'),
    ).toBe(true)
    // A number written as a boolean, in a real case's first exciter.
    const text = await readFile('cases/TwoArea.case.json', 'utf8')
    expect(fieldDefinition(catalog.definition, 'Ieeet1', 'params.Ispdlim')!.kind).toBe('number')
    const mistyped = await parse(text.replace(/"Ispdlim":\s*[-+.\deE]+/, '"Ispdlim": false'))
    expect(
      (await diagnose(mistyped, AbortSignal.any([]))).some(
        (issue) => issue.field === 'params.Ispdlim',
      ),
    ).toBe(true)
  })
  it('reads a key or a class written with escapes as the name it spells, as JSON does', async () => {
    const escaped = source
      .replace('{"class":"Branch","id":"line"', '{"cl\\u0061ss":"Br\\u0061nch","\\u0069d":"line"')
      .replace('"unknown":', '"unkn\\u006fwn":')
    const kase = await parse(escaped)
    // A Branch, known by its id, with its ports as a record written plainly has them.
    const branch = kase.table('Branch')
    expect(kase.entity(branch, 0)).toEqual({ table: 'Branch', id: 'line' })
    expect(kase.locate({ table: 'Bus', id: 42 })).not.toBeNull()
    // A key the catalog does not know is the column its escapes spell, placed where it is.
    expect(kase.found).toEqual([{ type: 'Branch', field: 'unknown', row: 0 }])
    expect(placed(kase, escaped, { table: 'Branch', id: 'line' }, 'unknown')).toBe('{"keep":1.000}')
    expect(placed(kase, escaped, { table: 'Branch', id: 'line' })).toMatch(/^\{"cl\\u0061ss"/)
  })
  it('reads a number of the case’s own as a record’s field reads one: finite, or not at all', async () => {
    const infinite = await parse(source.replace('"freq_base": 60.0', '"freq_base": 1e400'))
    expect(infinite.cell(infinite.table('Case'), 'params.freq_base', 0)).toBeNull()
    expect(await diagnose(infinite, AbortSignal.any([]))).toContainEqual(
      expect.objectContaining({
        entity: { table: 'Case', id: 'case' },
        field: 'params.freq_base',
        severity: 'error',
      }),
    )
    // What else its header or its parameters hold is the file's own, and no field of the case.
    const more = await parse(source.replace('"case_name":', '"author": "me", "case_name":'))
    expect(tableDefinition(more.definition, 'Case')).toEqual(
      tableDefinition(infinite.definition, 'Case'),
    )
    expect(more.name).toBe('東京 ⚡')
  })
  it('keeps what the catalog does not know: a member as a column, a class as a table', async () => {
    const text = source
      .replace('"devices":[', '"devices":[{"class":"Future","id":"next","params":{"gain":2.5}},')
      .replace('"params":{"kv":115.0}', '"params":{"kv":115.0,"kz":3},"extension":{"vset":1.03}')
    const kase = await parse(text)
    const buses = kase.table('Bus')
    expect(fieldDefinition(kase.definition, 'Bus', 'params.kz')).toMatchObject({ kind: 'number' })
    expect([kase.cell(buses, 'params.kz', 0), kase.cell(buses, 'params.kz', 1)]).toEqual([null, 3])
    // Placed where its record writes it, as a field the catalog knows is.
    expect(placed(kase, text, { table: 'Bus', id: 7 }, 'params.kz')).toBe('3')
    // An extension's keys are each tool's own, as GridKit's format has them: one Studio does not
    // know is a column it reads like any other, and nothing to warn of.
    expect(kase.cell(buses, 'extension.vset', 1)).toBe(1.03)
    expect(kase.cell(kase.table('Future'), 'params.gain', 0)).toBe(2.5)
    // An object is kept as its JSON text.
    expect(kase.cell(kase.table('Branch'), 'unknown', 0)).toBe('{"keep":1}')
    expect(await said(kase)).toEqual(
      expect.arrayContaining([
        ['warning', expect.stringMatching(/^Future is not a class/)],
        ['warning', expect.stringMatching(/^params\.kz is not a Bus field/)],
      ]),
    )
    expect(
      (await diagnose(kase, AbortSignal.any([]))).some(({ field }) => field === 'extension.vset'),
    ).toBe(false)
  })
  it('types a member the catalog does not know by what its rows write, in every chunk of its table', async () => {
    // More rows than a chunk holds, a row in a hundred writing each member.
    const rows = CHUNK_ROWS + 500
    const members = (at: number) =>
      at % 100
        ? ''
        : `,"spare":${at},"flag":${at % 200 === 0},"note":"n${at}","mixed":${at % 200 ? '"text"' : at},` +
          `"extension":{"tags":[${at}],"owner":null}`
    const text = `{"buses":[${Array.from(
      { length: rows },
      (_, at) => `{"class":"Bus","number":${at},"name":"b"${members(at)}}`,
    ).join(',')}]}`
    const kase = await parse(text)
    const buses = kase.table('Bus')
    // The table is cut where a chunk fills, and nowhere else: its rows keep their order across.
    expect([...buses.starts]).toEqual([0, CHUNK_ROWS, rows])
    expect(kase.locate({ table: 'Bus', id: CHUNK_ROWS + 1 })?.row).toBe(CHUNK_ROWS + 1)
    const kinds = Object.fromEntries(
      ['spare', 'flag', 'note', 'mixed', 'extension.tags', 'extension.owner'].map((field) => [
        field,
        fieldDefinition(kase.definition, 'Bus', field)?.kind,
      ]),
    )
    // Numbers, booleans and strings as they are; a mix, or anything else, as its JSON text; and a
    // member that is only ever null a column all the same.
    expect(kinds).toEqual({
      spare: 'number',
      flag: 'boolean',
      note: 'text',
      mixed: 'json',
      'extension.tags': 'json',
      'extension.owner': 'text',
    })
    const last = rows - (rows % 100)
    for (const row of [0, 100, CHUNK_ROWS - (CHUNK_ROWS % 100), last]) {
      expect(kase.cell(buses, 'spare', row)).toBe(row)
      expect(kase.cell(buses, 'flag', row)).toBe(row % 200 === 0)
      expect(kase.cell(buses, 'note', row)).toBe('n' + row)
      expect(kase.cell(buses, 'mixed', row)).toBe(row % 200 ? '"text"' : String(row))
      expect(kase.cell(buses, 'extension.tags', row)).toBe(`[${row}]`)
      expect(kase.cell(buses, 'extension.owner', row)).toBeNull()
      expect(placed(kase, text, { table: 'Bus', id: row }, 'spare')).toBe(String(row))
    }
    // A row that writes none holds none, on either side of a chunk's end.
    for (const row of [1, CHUNK_ROWS - 1, CHUNK_ROWS, CHUNK_ROWS + 1, rows - 1])
      expect([kase.cell(buses, 'spare', row), kase.cell(buses, 'note', row)]).toEqual([null, null])
    // Each is said once, where it is first written; an extension's are each tool's own.
    expect(kase.found.map(({ field, row }) => [field, row])).toEqual([
      ['spare', 0],
      ['flag', 0],
      ['note', 0],
      ['mixed', 0],
    ])
  })
  it('says a bus name or device id GridKit refuses is an error', async () => {
    const text = source
      .replace('"name":"Seven"', '"name":"Seven/7"')
      .replace('"id":"line"', '"id":"line:1"')
    const kase = await parse(text)
    const errors = (await diagnose(kase, AbortSignal.any([])))
      .filter(({ severity }) => severity === 'error')
      .map(({ entity, field, message }) => ({ entity, field, message }))
    const rule = 'only ASCII letters, digits, spaces, _, . and -'
    expect(errors).toEqual(
      expect.arrayContaining([
        { entity: { table: 'Bus', id: 7 }, field: 'name', message: `name may contain ${rule}.` },
        { entity: { table: 'Branch', id: 'line:1' }, message: `id may contain ${rule}.` },
      ]),
    )
    // A signal's name is the case's own, which GridKit takes as it is.
    expect(errors.some(({ entity }) => entity?.table === 'Signal')).toBe(false)
  })
  it('reads a bus’s class as a field of it, one of the classes its catalog gives', async () => {
    const text = source.replace('"class":"Bus","number":7', '"class":"BusDC","number":7')
    const issues = async (kase: Case) => (await said(kase)).map(([, message]) => message)
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
    for (const json of [null, {}, { bus: {}, classes: [] }, { case: {}, bus: { name: 'Bus' } }])
      expect(() => catalogOf(json)).toThrow('A catalog has a case, a bus and a list of classes.')
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
    expect(placed(kase, text, { table: 'Bus', id: 42 }, '"a.b"')).toBe('1.5')
    // A null is a missing value: the column stays a number.
    expect(fields.spare).toMatchObject({ kind: 'number' })
    const buses = kase.table('Bus')
    expect([kase.cell(buses, 'spare', 0), kase.cell(buses, 'spare', 1)]).toEqual([2, null])
  })
})
