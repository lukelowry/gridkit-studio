import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { Case } from './case.js'
import { catalog } from './definition.js'
import { apply } from './edits.js'
import { recordEdits, recordingOf } from './recording.js'
import { transaction } from './transactions.js'

const source = `{
 "buses": [
  {"class":"Bus","number":42,"name":"Forty-two","params":{"kv":230.000}},
  {"class":"Bus","number":7,"name":"Seven","params":{"kv":115.0},"mon":["Va"]}
 ],
 "devices":[
  {"class":"Branch","id":"line","ports":{"bus1":42,"bus2":7},"mon":["P1"]}
 ],
 "monitors":[{"file_name":"first.csv","format":"csv"},{"file_name":"out.csv","format":"CSV"},{"file_name":"out.bin","format":"binary"}]
}`

describe("a case's recording", () => {
  it('counts the outputs each type lists, and finds the monitor GridKit writes to', async () => {
    const recording = await recordingOf(await Case.parse(source, catalog))
    expect(recording.listed.Bus).toEqual({ Va: 1 })
    // GridKit takes the case's last CSV monitor.
    expect(recording.monitor).toEqual({ file: 'out.csv' })
    const bare = await Case.parse(source.replace(/,\s*"monitors":\[.*\]/, ''), catalog)
    expect((await recordingOf(bare)).monitor).toBeUndefined()
  })

  it('counts what any class lists as recorded, as GridKit records it', async () => {
    const listless = source.replace(/,"mon":\["(Va|P1)"\]/g, '')
    expect((await recordingOf(await Case.parse(listless, catalog))).anything).toBe(false)
    const future = listless.replace(
      '"devices":[',
      '"devices":[{"class":"Future","id":"next","mon":["out"]},',
    )
    expect(await recordingOf(await Case.parse(future, catalog))).toMatchObject({
      listed: {},
      anything: true,
    })
  })

  it('finds the file GridKit writes as it does: the last CSV monitor that uses commas', async () => {
    const monitor = async (sinks: string) =>
      (await recordingOf(await Case.parse(source.replace(/"monitors":\[.*\]/, sinks), catalog)))
        .monitor
    const csv = '{"file_name":"out.csv","format":"csv"}'
    const semi = '{"file_name":"semi.csv","format":"csv","delim":";"}'
    expect(await monitor(`"monitors":[${csv},${semi}]`)).toEqual({ file: 'out.csv' })
    // One that names no file leaves it to the solver file's output_file.
    expect(await monitor(`"monitors":[${csv},{"format":"csv"}]`)).toBeUndefined()
  })

  it('counts an element once for an output its list names twice', async () => {
    const twice = source.replace('"mon":["Va"]', '"mon":["Va","Va"]')
    expect((await recordingOf(await Case.parse(twice, catalog))).listed.Bus).toEqual({ Va: 1 })
  })

  it('counts what a release case lists, as its own file says', async () => {
    const text = await readFile('cases/IEEE39.case.json', 'utf8')
    const json = JSON.parse(text) as {
      devices: { class: string; mon?: string[] }[]
      buses: { mon?: string[] }[]
    }
    const listed: Record<string, Record<string, number>> = {}
    for (const { mon = [] } of json.buses)
      for (const name of mon) (listed.Bus ??= {})[name] = (listed.Bus?.[name] ?? 0) + 1
    for (const { class: type, mon = [] } of json.devices)
      for (const name of mon) (listed[type] ??= {})[name] = (listed[type]?.[name] ?? 0) + 1
    expect((await recordingOf(await Case.parse(text, catalog))).listed).toEqual(listed)
  })

  it('makes every element list a field, or none, keeping each list and every other byte', async () => {
    const kase = await Case.parse(source, catalog)
    const on = apply(source, recordEdits(kase, [{ type: 'Bus', add: ['Vm'], remove: [] }]))
    expect(JSON.parse(on).buses.map((bus: { mon?: string[] }) => bus.mon)).toEqual([
      ['Vm'],
      ['Va', 'Vm'],
    ])
    expect(on).toContain('"kv":230.000')
    expect(on).toContain('"mon":["P1"]')
    // Recording what every element records already changes nothing.
    const recorded = await Case.parse(on, catalog)
    expect(recordEdits(recorded, [{ type: 'Bus', add: ['Vm'], remove: [] }])).toEqual([])
    expect((await recordingOf(recorded)).listed.Bus).toEqual({ Va: 1, Vm: 2 })
    const off = apply(on, recordEdits(recorded, [{ type: 'Bus', add: [], remove: ['Vm'] }]))
    expect(JSON.parse(off).buses.map((bus: { mon?: string[] }) => bus.mon)).toEqual([[], ['Va']])
  })

  it('edits each element whose list changes, its list alone', async () => {
    const kase = await Case.parse(source, catalog)
    expect(recordEdits(kase, [{ type: 'Bus', add: ['Vm'], remove: [] }])).toEqual([
      { offset: source.indexOf('230.000}') + 8, length: 0, text: ', "mon": ["Vm"]' },
      { offset: source.indexOf('["Va"]'), length: 6, text: '["Va","Vm"]' },
    ])
  })

  it('records several types at once, their elements interleaved, in edits that never overlap', async () => {
    const text = source.replace(
      '{"class":"Branch","id":"line","ports":{"bus1":42,"bus2":7},"mon":["P1"]}',
      [
        '{"class":"Branch","id":"one","ports":{"bus1":42,"bus2":7}}',
        '{"class":"BusFault","id":"fault","ports":{"bus":7}}',
        '{"class":"Branch","id":"two","ports":{"bus1":42,"bus2":7}}',
      ].join(',\n  '),
    )
    const kase = await Case.parse(text, catalog)
    const edits = transaction(kase, [
      { kind: 'record', type: 'Branch', add: ['p1'], remove: [] },
      { kind: 'record', type: 'BusFault', add: ['ir'], remove: [] },
    ])
    for (let i = 1; i < edits.length; i++)
      expect(edits[i]!.offset).toBeGreaterThanOrEqual(edits[i - 1]!.offset + edits[i - 1]!.length)
    const devices = (JSON.parse(apply(text, edits)) as { devices: { mon?: string[] }[] }).devices
    expect(devices.map(({ mon }) => mon)).toEqual([['p1'], ['ir'], ['p1']])
  })

  it('changes what a case records in a transaction of its own, once per type', async () => {
    const kase = await Case.parse(source, catalog)
    const edits = transaction(kase, [{ kind: 'record', type: 'Bus', add: ['Va'], remove: [] }])
    expect(JSON.parse(apply(source, edits)).buses[0].mon).toEqual(['Va'])
    expect(() =>
      transaction(kase, [
        { kind: 'record', type: 'Bus', add: ['Va'], remove: [] },
        { kind: 'set', entity: { table: 'Bus', id: 7 }, field: 'params.kv', value: 138 },
      ]),
    ).toThrow('separate batch')
    expect(() =>
      transaction(kase, [
        { kind: 'record', type: 'Bus', add: ['Va'], remove: [] },
        { kind: 'record', type: 'Bus', add: [], remove: ['Va'] },
      ]),
    ).toThrow('once, in a separate batch')
  })
})
