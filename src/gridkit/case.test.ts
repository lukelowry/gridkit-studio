import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { Data } from 'latkit'
import { beforeAll, describe, expect, it } from 'vitest'

import { rowsOf } from '../shared/cells.js'
import { fieldDefinition, tableDefinition } from '../shared/document.js'
import type { Value } from '../shared/messages.js'
import { loadNative } from '../workers/native.js'
import { Case } from './case.js'
import { catalog, catalogOf } from './definition.js'
import { diagnose, editCase, editField, minimal, sourceRange } from './edits.js'
import { completionsAt, outline, sourceContext } from './navigation.js'
import { CaseQueries, project } from './projection.js'

beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))

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
  it('compiles GridKit metadata and native reference semantics', () => {
    expect(fieldDefinition(catalog.definition, 'BusFault', 'ports.control_signal')).toMatchObject({
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
    const kase = await Case.parse(source, catalog)
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
      for await (const bytes of project(
        projected,
        new Map([['Bus', ['name']]]),
        AbortSignal.any([]),
      ))
        data.apply(bytes)
      expect(data.query({ of: 'Bus' }).ids).toEqual([42, 7])
    } finally {
      queries.destroy()
      data.destroy()
    }
  })
  it('preserves numeric text, unknown properties and UTF-16 source positions', async () => {
    const kase = await Case.parse(source, catalog)
    const range = sourceRange(kase, { table: 'Bus', id: 42 }, 'name')
    expect(source.slice(range.offset, range.offset + range.length)).toBe('"東京 😀"')
    const next = apply(source, editField(kase, { table: 'Bus', id: 7 }, 'params.kv', 138))
    expect(next).toContain('"kv":138.0')
    expect(next).toContain('"kv":230.000')
    expect(next).toContain('"keep":1.000')
    expect(JSON.parse(next).buses[0].name).toBe('東京 😀')
    const updated = await Case.parse(next, catalog)
    expect(updated.version).not.toBe(kase.version)
  })
  it('validates references and preserves linked port locations', async () => {
    const kase = await Case.parse(source, catalog)
    expect(
      (await diagnose(kase, AbortSignal.any([]))).filter(({ severity }) => severity === 'error'),
    ).toEqual([])
    expect(() => editField(kase, { table: 'Branch', id: 'line' }, 'ports.bus2', 99)).toThrow()
    const next = apply(source, editField(kase, { table: 'Branch', id: 'line' }, 'ports.bus2', 42))
    expect(JSON.parse(next).devices[0].ports.bus2).toBe(42)
    const invalid = await Case.parse(source.replace('"bus2":7', '"bus2":999'), catalog)
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some(
        (issue) => issue.entity?.table === 'Branch' && issue.entity.id === 'line',
      ),
    ).toBe(true)
  })
  it('rejects duplicate IDs, malformed JSON and cancellation', async () => {
    await expect(Case.parse(source.replace('"number":7', '"number":42'), catalog)).rejects.toThrow()
    await expect(Case.parse(source.replace('"kv":115.0', '"kv":115.0,'), catalog)).rejects.toThrow()
    await expect(Case.parse(source, catalog, 'Case', AbortSignal.abort())).rejects.toThrow()
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
      const error = await Case.parse(text, catalog).catch((reason: unknown) => reason)
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
      await expect(Case.parse(text, catalog)).rejects.toThrow('Duplicate JSON property: ' + key)
    // Escapes JSON has read as their text, and a value nests as deep as it is written.
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const kase = await Case.parse(
      source
        .replace('"Seven"', '"Se\\u0076en \\"7\\"\\/\\\\"')
        .replace('"unknown":{"keep":1.000}', `"unknown":${deep}`),
      catalog,
    )
    expect(kase.cell(kase.table('Bus'), 'name', 1)).toBe('Seven "7"/\\')
  })
  it('says where each problem a parse finds is: the record it refuses, or the second of an id', async () => {
    const fault = '{"class":"BusFault","id":"fault"'
    for (const [text, record, said] of [
      // A bus, a signal and the case are types of their own, never a device's class.
      ...['Bus', 'Signal', 'Case'].map((type) => {
        const named = fault.replace('BusFault', type)
        return [source.replace(fault, named), named, `${type} is not a device class.`] as const
      }),
      [
        source.replace('"number":7', '"number":42'),
        '{"class":"Bus","number":42,"name":"Seven"',
        'Two rows share the number 42.',
      ],
      [
        source.replace('"id":"disconnected"', '"id":"fault"'),
        '{"class":"BusFault","id":"fault","ports":{"bus":7}}',
        'Two rows share the id fault.',
      ],
    ] as const) {
      const error = await Case.parse(text, catalog).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ code: 'invalid-input', message: said })
      // Where the editor finds the record, in UTF-16 units past the header's characters.
      expect(error).toMatchObject({ offset: text.indexOf(record) })
      expect((error as { length: number }).length).toBeGreaterThan(record.length - 1)
    }
  })
  it('reads an integer at either end of its range back as written', async () => {
    for (const value of [-0x8000_0000, 0x7fff_ffff]) {
      const kase = await Case.parse(
        source.replace(
          ']\n}',
          `,\n  {"class":"Esdc1a","id":"exciter","params":{"UEL":${value}}}\n ]\n}`,
        ),
        catalog,
      )
      expect(kase.cell(kase.table('Esdc1a'), 'params.UEL', 0)).toBe(value)
    }
  })
  it('refuses to read into a record nested deeper than the stack holds, as its own problem', async () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const text = source.replace('"unknown":{"keep":1.000}', `"unknown":${deep}`)
    const kase = await Case.parse(text, catalog)
    const tooDeep = { code: 'invalid-input', message: expect.stringMatching(/too deeply/) }
    for (const read of [
      () => sourceRange(kase, { table: 'Branch', id: 'line' }, 'ports.bus1'),
      () => editField(kase, { table: 'Branch', id: 'line' }, 'ports.bus2', 42),
      () => sourceContext(kase, text.indexOf('"bus1"')),
    ]) {
      const error = (() => {
        try {
          read()
        } catch (reason) {
          return reason
        }
      })()
      expect(error).toMatchObject(tooDeep)
    }
  })
  it('edits the case’s own fields in its header and params, each changed in one edit', async () => {
    const kase = await Case.parse(source, catalog)
    // A field written, and one not yet, of the header; and one of params, which the case lacks.
    const edits = editCase(
      kase,
      new Map<string, Value>([
        ['header.case_name', 'Kanto'],
        ['header.case_comments', 'Edited'],
        ['params.freq_base', 60],
      ]),
    )
    // Nothing past the header is touched but where params is made, before it.
    const header = source.indexOf('{"case_name"')
    expect(edits.every(({ offset }) => offset <= header + 30)).toBe(true)
    const next = JSON.parse(apply(source, edits)) as Record<string, Record<string, unknown>>
    expect(next.header).toEqual({ case_name: 'Kanto', case_comments: 'Edited' })
    expect(next.params).toEqual({ freq_base: 60 })
    expect(apply(source, edits)).toContain('"freq_base": 60.0')
    // A field of the case where it is, as Problems would place it.
    const range = sourceRange(kase, { table: 'Case', id: 'case' }, 'header.case_name')
    expect(source.slice(range.offset, range.offset + range.length)).toBe('"東京 ⚡"')
  })
  it('validates the case’s own fields without reading past them', async () => {
    const mistyped = await Case.parse(source.replace('"東京 ⚡"', '7'), catalog)
    const issues = await diagnose(mistyped, AbortSignal.any([]))
    expect(issues).toContainEqual(
      expect.objectContaining({
        entity: { table: 'Case', id: 'case' },
        field: 'header.case_name',
        severity: 'error',
      }),
    )
  })
  it('edits whole characters, never half of a surrogate pair', () => {
    for (const [before, after] of [
      ['"😀"', '"😁"'],
      ['"a😀"', '"a😁b"'],
      ['"😀"', '"🈀"'],
    ]) {
      const edit = minimal(before, after, 0)
      const made =
        before.slice(0, edit.offset) + edit.text + before.slice(edit.offset + edit.length)
      expect(made).toBe(after)
      expect(edit.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
      expect(before.slice(edit.offset, edit.offset + edit.length)).not.toMatch(
        /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/,
      )
    }
  })
  it('names the output a `mon` entry lists, where the cursor is in it', async () => {
    const text = source.replace('"ports":{"bus1":42,"bus2":7}', '$&,"mon":["p1","q1"]')
    const kase = await Case.parse(text, catalog)
    const at = text.indexOf('"q1"') + 1
    expect(sourceContext(kase, at)).toMatchObject({
      element: { table: 'Branch', id: 'line', field: 'q1' },
      range: { offset: at - 1, length: 4 },
    })
  })
  it('handles native infinite buses and reports invalid known values from the catalog', async () => {
    const kase = await Case.parse(await readFile('cases/TwoBusBasic.case.json', 'utf8'), catalog)
    expect(kase.table('Bus').records.length).toBe(2)
    const invalid = await Case.parse(source.replace('230.000', '1e400'), catalog)
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some((issue) => issue.field === 'params.kv'),
    ).toBe(true)
    await expect(Case.parse(source.replace('115.0', '115.0,"kv":116.0'), catalog)).rejects.toThrow()
  })
  it('reads a key or a class written with escapes as the name it spells, as JSON does', async () => {
    const escaped = source.replace(
      '{"class":"Branch","id":"line"',
      '{"cl\\u0061ss":"Br\\u0061nch","\\u0069d":"line"',
    )
    const kase = await Case.parse(escaped, catalog)
    // A Branch, known by its id, with its ports as a record written plainly has them.
    const branch = kase.table('Branch')
    expect(kase.entity(branch, 0)).toEqual({ table: 'Branch', id: 'line' })
    expect(kase.locate({ table: 'Bus', id: 42 })).not.toBeNull()
    expect(kase.found.some(({ field }) => field.includes('\\'))).toBe(false)
  })
  it('reads a number of the case’s own as a record’s field reads one: finite, or not at all', async () => {
    const kase = await Case.parse(source, catalog)
    const field = kase
      .table('Case')
      .shape.fields.find(
        ({ definition, source }) => definition.kind === 'number' && source.kind === 'parameter',
      )!
    const name = field.name.slice(field.name.indexOf('.') + 1)
    const infinite = await Case.parse(
      source.replace('"header":', `"params": {"${name}": 1e400}, "header":`),
      catalog,
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
  it('inserts native real-valued tokens without rewriting unrelated numbers', async () => {
    const text = source.replace('\"kv\":115.0', '')
    const kase = await Case.parse(text, catalog)
    const changed = apply(text, editField(kase, { table: 'Bus', id: 7 }, 'params.kv', 138))
    expect(changed).toMatch(/"kv":\s*138\.0/)
    expect(changed).toContain('230.000')
  })
  it('completes catalog fields in incomplete source', () => {
    const text = '{"buses":[{"class":"Bus","number":1,"params":{"k'
    expect(completionsAt(catalog, text, text.length).map((field) => field.name)).toContain('kv')
  })
  it('completes from the record the cursor is in alone, where the case read before still has it', async () => {
    const read = { kase: await Case.parse(source, catalog), text: source }
    const names = (text: string, offset: number, from?: typeof read) =>
      completionsAt(catalog, text, offset, from).map((field) => field.name)
    // A key typed into the Branch's params, as the case read before has the Branch.
    const at = source.indexOf('"unknown"')
    const typing = '"params":{"'
    const typed = source.slice(0, at) + typing + source.slice(at)
    expect(names(typed, at + typing.length, read)).toEqual(names(typed, at + typing.length))
    expect(names(typed, at + typing.length, read).length).toBeGreaterThan(0)
    // A record added since: no record the case read before holds the cursor.
    const end = source.lastIndexOf(']')
    const adding = ',{"class":"Genrou","params":{"'
    const added = source.slice(0, end) + adding + source.slice(end)
    expect(names(added, end + adding.length, read)).toEqual(names(added, end + adding.length))
  })
  it('completes by the class of the record the cursor is in, past the records before it', () => {
    const names = (text: string) => completionsAt(catalog, text, text.length).map((f) => f.name)
    const alone = names('{"devices":[{"class":"Genrou","params":{"')
    expect(alone.length).toBeGreaterThan(0)
    expect(
      names(
        '{"devices":[{"class":"Branch","params":{"x":1},"mon":["a"]},{"class":"Genrou","params":{"',
      ),
    ).toEqual(alone)
    expect(names('{"devices":[{"class":"Branch","params":{"')).not.toEqual(alone)
  })
  it('outlines every record in file order under its array, where the editor finds each', async () => {
    const kase = await Case.parse(source, catalog)
    const symbols = await outline(kase, new AbortController().signal)
    expect(symbols.map(({ name, detail }) => [name, detail])).toEqual([
      ['buses', '2'],
      ['signals', '1'],
      ['devices', '4'],
    ])
    for (const array of symbols) {
      // Counted in UTF-16, past a name outside the Basic Multilingual Plane.
      expect(source.slice(array.offset, array.offset + array.length)).toMatch(/^\[[\s\S]*\]$/)
      const offsets = array.children!.map(({ offset }) => offset)
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
      for (const { offset, length } of array.children!) {
        const context = sourceContext(kase, offset + 1)
        expect({ offset, length }).toEqual(sourceRange(kase, context.element!))
      }
    }
    // Past VS Code's limit for a JSON file's outline, each array says how many it lists.
    const limited = await outline(kase, new AbortController().signal, 3)
    expect(limited.map(({ detail, children }) => [detail, children!.length])).toEqual([
      ['2', 2],
      ['1', 1],
      ['0 of 4', 0],
    ])
    expect(limited.map(({ offset, length }) => [offset, length])).toEqual(
      symbols.map(({ offset, length }) => [offset, length]),
    )
  })
  it('loads the real TwoArea case', async () => {
    const kase = await Case.parse(await readFile('cases/TwoArea.case.json', 'utf8'), catalog)
    expect(kase.table('Bus').records.length).toBe(10)
    expect(kase.tables.get('Branch')).toBeDefined()
    expect(await diagnose(kase, AbortSignal.any([]))).toEqual([])
    expect(fieldDefinition(catalog.definition, 'Ieeet1', 'params.Ispdlim')!.kind).toBe('number')
    const id = kase.entity(kase.table('Ieeet1'), 0)
    const changed = apply(
      new TextDecoder().decode(kase.file),
      editField(kase, id, 'params.Ispdlim', 1),
    )
    expect(changed).toMatch(/"Ispdlim":\s*1\.0/)
    const invalid = await Case.parse(
      changed.replace(/"Ispdlim":\s*1\.0/, '"Ispdlim":false'),
      catalog,
    )
    expect(
      (await diagnose(invalid, AbortSignal.any([]))).some(
        (issue) => issue.field === 'params.Ispdlim',
      ),
    ).toBe(true)
  })
  it('keeps what the catalog does not know: a member as a column, a class as a table', async () => {
    const text = source
      .replace('"devices":[', '"devices":[{"class":"Future","id":"next","params":{"gain":2.5}},')
      .replace('"params":{"kv":115.0}', '"params":{"kv":115.0,"kz":3}')
    const kase = await Case.parse(text, catalog)
    const buses = kase.table('Bus')
    expect(fieldDefinition(kase.definition, 'Bus', 'params.kz')).toMatchObject({ kind: 'number' })
    expect([kase.cell(buses, 'params.kz', 0), kase.cell(buses, 'params.kz', 1)]).toEqual([null, 3])
    expect(kase.cell(kase.table('Future'), 'params.gain', 0)).toBe(2.5)
    // An object is kept as its JSON text, and not edited in place.
    expect(kase.cell(kase.table('Branch'), 'unknown', 0)).toBe('{"keep":1}')
    expect(() => editField(kase, { table: 'Branch', id: 'line' }, 'unknown', '{}')).toThrow()
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
    const next = apply(text, editField(kase, { table: 'Bus', id: 7 }, 'params.kz', 4))
    expect(JSON.parse(next).buses[1].params.kz).toBe(4)
  })
  it('reads a bus’s class as a field of it, one of the classes its catalog gives', async () => {
    const text = source.replace('"class":"Bus","number":7', '"class":"SignalVoltageIn","number":7')
    const issues = async (kase: Case) =>
      (await diagnose(kase, AbortSignal.any([]))).map(({ message }) => message)
    const kase = await Case.parse(text, catalog)
    const buses = kase.table('Bus')
    expect([kase.cell(buses, 'class', 0), kase.cell(buses, 'class', 1)]).toEqual([
      'Bus',
      'SignalVoltageIn',
    ])
    expect(await issues(kase)).toContain(
      'SignalVoltageIn is not a Bus class GridKit Studio knows; it is kept as written.',
    )
    expect(
      JSON.parse(apply(text, editField(kase, { table: 'Bus', id: 7 }, 'class', 'Bus'))).buses[1]
        .class,
    ).toBe('Bus')
    // A catalog that gives the class, as one for a later GridKit would, reads it as any other.
    const bundled = JSON.parse(catalog.text) as { bus: { classes: string[] } }
    const later = catalogOf({
      ...bundled,
      bus: { ...bundled.bus, classes: [...bundled.bus.classes, 'SignalVoltageIn'] },
    })
    expect((await issues(await Case.parse(text, later))).join()).not.toMatch(/SignalVoltageIn/)
    // What is no catalog says so, as plainly as GridKit Studio can.
    for (const json of [null, {}, { bus: {}, classes: [] }, { bus: { name: 'Bus' } }])
      expect(() => catalogOf(json)).toThrow('A catalog has a bus and a list of classes.')
  })

  it('numbers a table’s rows by its ids, alike in any revision that keeps them', async () => {
    const indexes = async (text: string) => {
      const kase = await Case.parse(text, catalog)
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
      .replace('"name":"東京 😀"', '"name":"東京 😀","spare":2,"a.b":1.5')
    const kase = await Case.parse(text, catalog)
    const fields = Object.fromEntries(
      tableDefinition(kase.definition, 'Bus')!.fields.map((field) => [field.name, field]),
    )
    // The output whose name it takes is named by where it is listed, as for a known key's.
    expect(fields.Vm).toMatchObject({ kind: 'number' })
    expect(fields['mon.Vm']).toMatchObject({ kind: 'sampled', label: 'Vm' })
    // A key with a point is no path through a record key.
    expect(fields['"a.b"']).toMatchObject({ kind: 'number' })
    // A null is a missing value: the column stays a number, which edits as one.
    expect(fields.spare).toMatchObject({ kind: 'number' })
    const buses = kase.table('Bus')
    expect([kase.cell(buses, 'spare', 0), kase.cell(buses, 'spare', 1)]).toEqual([2, null])
    // An integer it holds stays one: GridKit may read an integer there.
    expect(apply(text, editField(kase, { table: 'Bus', id: 42 }, 'spare', 4))).toContain(
      '"spare":4,',
    )
    expect(apply(text, editField(kase, { table: 'Bus', id: 7 }, 'Vm', 1.05))).toContain(
      '"Vm":1.05,',
    )
  })
})
