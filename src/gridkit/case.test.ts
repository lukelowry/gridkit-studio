import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { type Entity, fieldDefinition, tableDefinition } from '../shared/document.js'
import { Case, versionOf } from './case.js'
import { CHUNK_ROWS } from './columns.js'
import { type Catalog, catalog, catalogOf, definitionsOf } from './definition.js'
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
const parse = (text: string, using: Catalog = catalog) =>
  Case.parse(new TextEncoder().encode(text), using)
const issuesOf = async (kase: Case) =>
  (await diagnose(kase, AbortSignal.any([]))).map(({ severity, message }) => [severity, message])
const textOf = (kase: Case, text: string, id: Entity, field?: string) => {
  const { offset, length } = sourceRange(kase, id, field)
  return text.slice(offset, offset + length)
}
const definition = definitionsOf([...catalog.shapes.values()])
/** The repeated-key warnings of `kase`, each with the key's source text. */
const repeats = async (kase: Case, text: string) =>
  (await diagnose(kase, AbortSignal.any([])))
    .filter(({ message }) => message.includes('more than once'))
    .map(({ offset, length, message, entity }) => ({
      at: offset,
      key: text.slice(offset, offset + length),
      message,
      entity,
    }))

describe('single catalog and source ownership', () => {
  it('compiles GridKit metadata and native reference semantics', () => {
    expect(fieldDefinition(definition, 'GenClassical', 'ports.pmech')).toMatchObject({
      kind: 'reference',
      target: 'Signal',
    })
    expect(
      catalog.shapes.get('GenClassical')!.ports.find(({ name }) => name === 'ports.pmech'),
    ).toMatchObject({ direction: 'in' })
    expect(definition.drawing.edges.find((edge) => edge.table === 'Branch')).toEqual({
      table: 'Branch',
      ends: ['ports.bus1', 'ports.bus2'],
      bends: 'extension.polyline',
    })
    expect(definition.drawing.vertices.find((vertex) => vertex.table === 'Bus')?.position).toEqual([
      'extension.longitude',
      'extension.latitude',
    ])
  })
  it('places fields in UTF-16 units and fingerprints the file with its catalog', async () => {
    const kase = await parse(source)
    expect(textOf(kase, source, { table: 'Signal', id: 1 }, 'name')).toBe('"setpoint 😀"')
    const updated = await parse(source.replace('"kv":115.0', '"kv":138.0'))
    expect(updated.version).not.toBe(kase.version)
    expect((await parse(source)).version).toBe(kase.version)
    // The fingerprint comes from the bytes alone, before parsing.
    expect(await versionOf(catalog, new TextEncoder().encode(source))).toBe(kase.version)
    const revised = catalogOf({ ...JSON.parse(catalog.text), revision: 2 })
    expect((await parse(source, revised)).version).not.toBe(kase.version)
  })
  it('validates references and preserves linked port locations', async () => {
    const kase = await parse(source)
    expect((await issuesOf(kase)).filter(([severity]) => severity === 'error')).toEqual([])
    const invalid = await parse(source.replace('"bus2":7', '"bus2":999'))
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some(
        (issue) => issue.entity?.table === 'Branch' && issue.entity.id === 'line',
      ),
    ).toBe(true)
  })
  it('accepts strict JSON only and reports where it fails', async () => {
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
    // Deep nesting does not stop the rest of the record from being read.
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const text = source
      .replace('"Seven"', '"Se\\u0076en \\"7\\"\\/\\\\"')
      .replace('"unknown":{"keep":1.000}', `"unknown":${deep}`)
    const kase = await parse(text)
    expect(kase.cell(kase.table('Bus'), 'name', 1)).toBe('Seven "7"/\\')
    expect(textOf(kase, text, { table: 'Branch', id: 'line' }, 'ports.bus1')).toBe('42')
  })
  it('reads a repeated key as GridKit does, keeping the last value, and warns where', async () => {
    const warned = (key: string, table: string, id: string | number) => ({
      key: `"${key}"`,
      message: `${key} is written more than once here; GridKit reads its last value.`,
      entity: { table, id },
    })
    const field = source.replace('"kv":115.0', '"kv":115.0,"\\u006bv":116.0')
    let kase = await parse(field)
    expect(kase.cell(kase.table('Bus'), 'params.kv', 1)).toBe(116)
    expect(textOf(kase, field, { table: 'Bus', id: 7 }, 'params.kv')).toBe('116.0')
    expect(await repeats(kase, field)).toEqual([
      { at: field.indexOf('"\\u006bv"'), ...warned('kv', 'Bus', 7), key: '"\\u006bv"' },
    ])
    const record = source.replace(
      '{"class":"GenClassical","id":"disconnected"',
      '{"class":"Branch","id":"first","class":"GenClassical","id":"disconnected"',
    )
    kase = await parse(record)
    expect(kase.locate({ table: 'GenClassical', id: 'disconnected' })).not.toBeNull()
    expect(kase.table('Branch').records).toHaveLength(1)
    expect((await repeats(kase, record)).map(({ key }) => key)).toEqual(['"class"', '"id"'])
    // A repeated group replaces the earlier one entirely, unknown members included.
    const group = source.replace(
      '"params":{"kv":115.0}',
      '"params":{"kv":115.0,"kz":1},"params":{"kv":120.0}',
    )
    kase = await parse(group)
    expect(kase.cell(kase.table('Bus'), 'params.kv', 1)).toBe(120)
    expect(fieldDefinition(kase.definition, 'Bus', 'params.kz')).toBeUndefined()
    expect(await repeats(kase, group)).toEqual([
      { at: group.indexOf('"params":{"kv":120.0}'), ...warned('params', 'Bus', 7) },
    ])
    const unknown = source.replace('"unknown":{"keep":1.000}', '"unknown":1,"unknown":2')
    kase = await parse(unknown)
    expect(kase.cell(kase.table('Branch'), 'unknown', 0)).toBe(2)
    expect((await repeats(kase, unknown)).map(({ at }) => at)).toEqual([
      unknown.lastIndexOf('"unknown"'),
    ])
    const own = source.replace(/}\s*$/, ',"signals":[]}')
    kase = await parse(own)
    expect(kase.table('Signal').records).toHaveLength(0)
    expect(await repeats(kase, own)).toEqual([
      { at: own.lastIndexOf('"signals"'), ...warned('signals', 'Case', 'case') },
    ])
    // Inside a value kept as JSON text, repeated keys stay as written.
    const many = Array.from({ length: 200 }, (_, i) => `"k${i}":${i}`).join(',') + ',"k50":0'
    const kept = source.replace('"keep":1.000', many)
    kase = await parse(kept)
    expect(kase.cell(kase.table('Branch'), 'unknown', 0)).toBe(`{${many}}`)
  })
  it('locates each parse problem: the rejected record or the duplicate id', async () => {
    const fault = '{"class":"GenClassical","id":"fault"'
    for (const [text, record, message] of [
      // Bus, Signal and Case are types of their own, never device classes.
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
      expect(error).toMatchObject({ code: 'invalid-input', message })
      expect(error).toMatchObject({ offset: text.indexOf(record) })
      expect((error as { length: number }).length).toBeGreaterThan(record.length - 1)
    }
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
    // Duplicate ids and non-object records are reported together in file order.
    const thrice = source
      .replace('"number":7', '"number":42')
      .replace('"devices":[', '"devices":[null,')
      .replace('"buses": [', '"buses": [{"class":"Bus","number":42,"name":"First","params":{}},')
    const all = (await parse(thrice).catch((reason: unknown) => reason)) as {
      problems: { message: string; offset: number }[]
    }
    expect(all.problems.map(({ message }) => message)).toEqual([
      'Two rows share the number 42.',
      'Two rows share the number 42.',
      "Each of the case's devices is written as an object.",
    ])
    const offsets = all.problems.map(({ offset }) => offset)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(thrice.slice(offsets[2], offsets[2]! + 4)).toBe('null')
    const classless = Array.from({ length: 250 }, (_, at) => `{"id":"d${at}"}`).join(',')
    const many = (await parse(`{"buses":[],"devices":[${classless}]}`).catch(
      (reason: unknown) => reason,
    )) as { problems: unknown[] }
    expect(many.problems).toHaveLength(250)
  })
  it('reads an integer as GridKit does: any whole number, however it is written', async () => {
    const exciter = (value: string) =>
      parse(
        source.replace(
          ']\n}',
          `,\n  {"class":"Esdc1a","id":"exciter","params":{"UEL":${value}},"ports":{}}\n ]\n}`,
        ),
      )
    for (const [written, value] of [
      ['-2147483648', -0x8000_0000],
      ['2147483647', 0x7fff_ffff],
      ['1099511627776', 2 ** 40],
      ['1.0', 1],
      ['1e3', 1000],
      ['-2.0E0', -2],
    ] as const) {
      const kase = await exciter(written)
      expect(kase.cell(kase.table('Esdc1a'), 'params.UEL', 0)).toBe(value)
    }
    for (const real of ['2.5', '1e-3', '1e400']) {
      const kase = await exciter(real)
      expect(kase.cell(kase.table('Esdc1a'), 'params.UEL', 0)).toBeNull()
      expect(await issuesOf(kase)).toContainEqual(['error', 'Invalid params.UEL value.'])
    }
  })
  it('reads an id or a port as GridKit does: any whole number of 0 or more, however it is written', async () => {
    const big = 5_000_000_000
    const text = source
      .replace('"number":42', `"number":${big}`)
      .replace('"bus1":42', `"bus1":${big}.0`)
      .replace('"signal_id":1', '"signal_id":1e0')
    const kase = await parse(text)
    expect(kase.locate({ table: 'Bus', id: big })?.row).toBe(0)
    expect(kase.locate({ table: 'Signal', id: 1 })?.row).toBe(0)
    expect(kase.cell(kase.table('Branch'), 'ports.bus1', 0)).toBe(big)
    expect(
      (await issuesOf(await parse(text.replace('"bus":42', `"bus":${big}`)))).filter(
        ([severity]) => severity === 'error',
      ),
    ).toEqual([])
    for (const number of ['-1', '7.5'])
      await expect(parse(source.replace('"number":7', `"number":${number}`))).rejects.toThrow(
        "A Bus record's number is not a whole number of 0 or more.",
      )
  })
  it('reads each number as the double nearest what is written, however many digits it has', async () => {
    const numbers = [
      ...['0', '-0', '1e0', '1E5', '1e-5', '0.1', '230.000', '0.30000000000000004'],
      // 15 digits, 16, and more than a double can represent.
      ...['123456789012345', '1234567890123456', '12345678901234567', '0.1234567890123456789'],
      // Around the largest exact integer, and powers of ten near the fast-path limit.
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
      // Known and unknown fields decode the same. Negative zero keeps its sign.
      expect(Object.is(kase.cell(buses, 'params.kv', row), Number(written))).toBe(true)
      expect(Object.is(kase.cell(buses, 'spare', row), Number(written))).toBe(true)
    }
  })
  it('places the case’s own fields in its header', async () => {
    const kase = await parse(source)
    expect(textOf(kase, source, { table: 'Case', id: 'case' }, 'header.case_name')).toBe(
      '"東京 ⚡"',
    )
    expect(textOf(kase, source, { table: 'Case', id: 'case' }, 'params.va_base')).toBe('100e6')
    // The case's row maps to its header, and a missing field to the header's start.
    const header = JSON.stringify(JSON.parse(source).header)
    expect(JSON.parse(textOf(kase, source, { table: 'Case', id: 'case' }))).toEqual(
      JSON.parse(header),
    )
    expect(textOf(kase, source, { table: 'Case', id: 'case' }, 'header.case_date_time')).toBe('{')
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
  it('reports each member GridKit requires that a case lacks', async () => {
    expect(await issuesOf(await parse(source))).toEqual([
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
        // A group that is not an object counts as missing.
        { entity: { table: 'Bus', id: 2 }, message: 'A Bus record has no params.', at: '{' },
      ]),
    )
    // An unknown class gets a warning only, with no errors for its records.
    expect(errors.some(({ entity }) => entity?.table === 'Future')).toBe(false)
    expect(errors.some(({ message }) => /has no (header|buses|devices)/.test(message))).toBe(false)
    // Missing arrays and groups are errors, and so are ones of the wrong type.
    for (const text of [
      '{}',
      '{"header":[],"params":5,"buses":{},"devices":null}',
      '{"header":{},"header":null,"params":{},"params":"","buses":[],"buses":{},"devices":[],"devices":0}',
    ]) {
      const kase = await parse(text)
      expect(await issuesOf(kase)).toEqual(
        expect.arrayContaining(
          ['header', 'params', 'buses', 'devices'].map((member) => [
            'error',
            `The case has no ${member}.`,
          ]),
        ),
      )
    }
    // A record's group of the wrong type does not become a column.
    const mistyped = await parse(source.replace('"params":{"kv":115.0}', '"params":5'))
    expect(fieldDefinition(mistyped.definition, 'Bus', 'params')).toBeUndefined()
    expect(await issuesOf(mistyped)).toContainEqual(['error', 'A Bus record has no params.'])
  })
  it('reports a value its field cannot decode as invalid', async () => {
    const invalid = await parse(source.replace('230.000', '1e400'))
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some((issue) => issue.field === 'params.kv'),
    ).toBe(true)
    const text = await readFile('cases/TwoArea.case.json', 'utf8')
    expect(fieldDefinition(definition, 'Ieeet1', 'params.Ispdlim')!.kind).toBe('number')
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
    // The Branch is found by its id, with ports as if written without escapes.
    const branch = kase.table('Branch')
    expect(kase.entity(branch, 0)).toEqual({ table: 'Branch', id: 'line' })
    expect(kase.locate({ table: 'Bus', id: 42 })).not.toBeNull()
    // An unknown escaped key becomes the column it spells, located at its source.
    expect(kase.found).toEqual([{ type: 'Branch', field: 'unknown', row: 0 }])
    expect(textOf(kase, escaped, { table: 'Branch', id: 'line' }, 'unknown')).toBe('{"keep":1.000}')
    expect(textOf(kase, escaped, { table: 'Branch', id: 'line' })).toMatch(/^\{"cl\\u0061ss"/)
  })
  it('reads the case’s own numbers like record fields: finite, or null', async () => {
    const infinite = await parse(source.replace('"freq_base": 60.0', '"freq_base": 1e400'))
    expect(infinite.cell(infinite.table('Case'), 'params.freq_base', 0)).toBeNull()
    expect(await diagnose(infinite, AbortSignal.any([]))).toContainEqual(
      expect.objectContaining({
        entity: { table: 'Case', id: 'case' },
        field: 'params.freq_base',
        severity: 'error',
      }),
    )
    // Other members of the header or params are not case fields.
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
    expect(textOf(kase, text, { table: 'Bus', id: 7 }, 'params.kz')).toBe('3')
    // Extension keys belong to each tool, so an unknown one is read as a column without a warning.
    expect(kase.cell(buses, 'extension.vset', 1)).toBe(1.03)
    expect(kase.cell(kase.table('Future'), 'params.gain', 0)).toBe(2.5)
    expect(kase.cell(kase.table('Branch'), 'unknown', 0)).toBe('{"keep":1.000}')
    expect(await issuesOf(kase)).toEqual(
      expect.arrayContaining([
        ['warning', expect.stringMatching(/^Future is not a class/)],
        ['warning', expect.stringMatching(/^params\.kz is not a Bus field/)],
      ]),
    )
    expect(
      (await diagnose(kase, AbortSignal.any([]))).some(({ field }) => field === 'extension.vset'),
    ).toBe(false)
  })
  it('types an unknown member by its values across every chunk of its table', async () => {
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
    // The table splits only where a chunk fills, and rows keep their order across it.
    expect([...buses.starts]).toEqual([0, CHUNK_ROWS, rows])
    expect(kase.locate({ table: 'Bus', id: CHUNK_ROWS + 1 })?.row).toBe(CHUNK_ROWS + 1)
    const kinds = Object.fromEntries(
      ['spare', 'flag', 'note', 'mixed', 'extension.tags', 'extension.owner'].map((field) => [
        field,
        fieldDefinition(kase.definition, 'Bus', field)?.kind,
      ]),
    )
    // Mixed and nested values become JSON text, and an all-null member is still a column.
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
      expect(textOf(kase, text, { table: 'Bus', id: row }, 'spare')).toBe(String(row))
    }
    // A row without the member has null, on both sides of a chunk boundary.
    for (const row of [1, CHUNK_ROWS - 1, CHUNK_ROWS, CHUNK_ROWS + 1, rows - 1])
      expect([kase.cell(buses, 'spare', row), kase.cell(buses, 'note', row)]).toEqual([null, null])
    // Each unknown member is listed once, at its first row. Extension members are not listed.
    expect(kase.found.map(({ field, row }) => [field, row])).toEqual([
      ['spare', 0],
      ['flag', 0],
      ['note', 0],
      ['mixed', 0],
    ])
  })
  it('reports a bus name or device id GridKit rejects as an error', async () => {
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
    // GridKit accepts any signal name.
    expect(errors.some(({ entity }) => entity?.table === 'Signal')).toBe(false)
  })
  it('reads a bus’s class as a field with the catalog’s classes as choices', async () => {
    const text = source.replace('"class":"Bus","number":7', '"class":"BusDC","number":7')
    const issues = async (kase: Case) => (await issuesOf(kase)).map(([, message]) => message)
    const kase = await parse(text)
    const buses = kase.table('Bus')
    expect([kase.cell(buses, 'class', 0), kase.cell(buses, 'class', 1)]).toEqual(['Bus', 'BusDC'])
    expect(await issues(kase)).toContain(
      'BusDC is not a Bus class GridKit Studio knows; it is kept as written.',
    )
    // A catalog that lists the class, as a later GridKit's might, accepts it.
    const bundled = JSON.parse(catalog.text) as { bus: { classes: string[] } }
    const later = catalogOf({
      ...bundled,
      bus: { ...bundled.bus, classes: [...bundled.bus.classes, 'BusDC'] },
    })
    expect((await issues(await parse(text, later))).join()).not.toMatch(/BusDC/)
    for (const json of [null, {}, { bus: {}, classes: [] }, { case: {}, bus: { name: 'Bus' } }])
      expect(() => catalogOf(json)).toThrow('A catalog needs case, bus and classes entries.')
  })
  it('keeps an unknown key that shares a known name, contains a dot, or is null', async () => {
    const text = source
      .replace('"name":"Seven"', '"name":"Seven","Vm":1.0,"spare":null')
      .replace('"name":"Tokyo 1"', '"name":"Tokyo 1","spare":2,"a.b":1.5')
    const kase = await parse(text)
    const fields = Object.fromEntries(
      tableDefinition(kase.definition, 'Bus')!.fields.map((field) => [field.name, field]),
    )
    // The output it collides with is renamed to `mon.Vm`.
    expect(fields.Vm).toMatchObject({ kind: 'number' })
    expect(fields['mon.Vm']).toMatchObject({ kind: 'sampled', label: 'Vm' })
    // A key with a dot is not read as a path.
    expect(fields['"a.b"']).toMatchObject({ kind: 'number' })
    expect(textOf(kase, text, { table: 'Bus', id: 42 }, '"a.b"')).toBe('1.5')
    // Null is a missing value, so the column stays numeric.
    expect(fields.spare).toMatchObject({ kind: 'number' })
    const buses = kase.table('Bus')
    expect([kase.cell(buses, 'spare', 0), kase.cell(buses, 'spare', 1)]).toEqual([2, null])
  })
  it('reports which of many required members a record lacks', async () => {
    const members = Array.from({ length: 40 }, (_, at) => 'm' + at)
    const bundled = JSON.parse(catalog.text) as object
    const demanding = catalogOf({ ...bundled, device: { required: members } })
    const written = Object.fromEntries(members.slice(0, -1).map((member) => [member, {}]))
    const text = JSON.stringify({
      buses: [],
      devices: [{ class: 'Branch', id: 'line', ...written }],
    })
    const kase = await parse(text, demanding)
    expect([...kase.table('Branch').lacks.keys()]).toEqual(['m39'])
  })
})
