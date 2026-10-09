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
 "monitors":[{"file_name":"first.csv","format":"csv"},{"file_name":"out.csv","format":"CSV"}]
}`

describe("a case's recording", () => {
  it('counts the outputs each type lists, and finds the monitor GridKit writes to', async () => {
    const recording = recordingOf(await Case.parse(source, catalog))
    expect(recording.listed.Bus).toEqual({ Va: 1 })
    // GridKit takes the case's last CSV monitor.
    expect(recording.monitor).toEqual({ file: 'out.csv', format: 'csv' })
    const bare = await Case.parse(source.replace(/,\s*"monitors":\[.*\]/, ''), catalog)
    expect(recordingOf(bare).monitor).toBeUndefined()
  })

  it('counts what a release case lists, as its own file says', async () => {
    const text = await readFile('cases/IEEE39.case.json', 'utf8')
    const json = JSON.parse(text) as { devices: { class: string; mon?: string[] }[] }
    const listed: Record<string, Record<string, number>> = {}
    for (const { class: type, mon = [] } of json.devices)
      for (const name of mon) (listed[type] ??= {})[name] = (listed[type]?.[name] ?? 0) + 1
    expect(recordingOf(await Case.parse(text, catalog)).listed).toEqual(listed)
  })

  it('makes every element list a field, or none, keeping each list and every other byte', async () => {
    const kase = await Case.parse(source, catalog)
    const on = apply(source, recordEdits(kase, 'Bus', ['Vm'], []))
    expect(JSON.parse(on).buses.map((bus: { mon?: string[] }) => bus.mon)).toEqual([
      ['Vm'],
      ['Va', 'Vm'],
    ])
    expect(on).toContain('"kv":230.000')
    expect(on).toContain('"mon":["P1"]')
    // Recording what every element records already changes nothing.
    const recorded = await Case.parse(on, catalog)
    expect(recordEdits(recorded, 'Bus', ['Vm'], [])).toEqual([])
    expect(recordingOf(recorded).listed.Bus).toEqual({ Va: 1, Vm: 2 })
    const off = apply(on, recordEdits(recorded, 'Bus', [], ['Vm']))
    expect(JSON.parse(off).buses.map((bus: { mon?: string[] }) => bus.mon)).toEqual([[], ['Va']])
  })

  it('changes what a case records in a transaction of its own, once per type', async () => {
    const kase = await Case.parse(source, catalog)
    const edits = transaction(kase, [{ kind: 'record', type: 'Bus', add: ['Va'], remove: [] }])
    expect(JSON.parse(apply(source, edits)).buses[0].mon).toEqual(['Va'])
    expect(() =>
      transaction(kase, [
        { kind: 'record', type: 'Bus', add: ['Va'], remove: [] },
        { kind: 'set', id: 'Bus/7', field: 'params.kv', value: 138 },
      ]),
    ).toThrow('a batch of its own')
    expect(() =>
      transaction(kase, [
        { kind: 'record', type: 'Bus', add: ['Va'], remove: [] },
        { kind: 'record', type: 'Bus', add: [], remove: ['Va'] },
      ]),
    ).toThrow('once in a batch')
  })
})
