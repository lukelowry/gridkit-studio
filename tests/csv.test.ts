import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { CHUNK_BYTES, decoder, header } from '../src/csv/decode.js'
import { CsvFile } from '../src/csv/worker.js'
const numbers = (text: string, width: number, columns: number[]) => decoder(width, columns)(text)
import { bindColumns } from '../src/csv/columns.js'
import { parse } from '../src/gridkit/parse.js'
import { validate } from '../src/gridkit/validate.js'
import { caseText } from './support/case.js'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'gridkit-csv-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'mon.csv')
  await writeFile(path, text)
  const csv = new CsvFile(path)
  cleanup.push(() => csv.dispose())
  return { csv, path }
}
it('reads complete live rows, CRLF, duplicate event times, and the last unterminated row', async () => {
  const { csv, path } = await fixture('t,Bus_bus_Vm\r\n0,1.000000000000001\r\n1,2\r\n1,3\r\n2,')
  expect((await csv.scan(false)).rows).toBe(3)
  expect([...(await csv.read(await csv.locate(1), 1, [1])).values]).toEqual([3])
  await appendFile(path, '4')
  expect((await csv.scan(true)).rows).toBe(4)
  expect([...(await csv.read(await csv.locate(0), 1, [1])).values]).toEqual([1.000000000000001])
  expect([...(await csv.read(await csv.locate(2), 1, [1])).values]).toEqual([4])
})
it('handles byte-chunk boundaries without consuming an incomplete row', async () => {
  const { csv } = await fixture('t,Bus_bus_Vm\n0,0.' + '0'.repeat(CHUNK_BYTES + 7) + '1\n1,2')
  expect((await csv.scan(false)).rows).toBe(1)
  expect((await csv.scan(true)).rows).toBe(2)
})
it('rejects decreasing/nonfinite time and malformed records while preserving missing/nonfinite values', async () => {
  expect(header('t,"Bus_a_b_Vm"')).toEqual(['t', 'Bus_a_b_Vm'])
  expect([...numbers('0,,nan,inf,-inf', 5, [1, 2, 3, 4]).values]).toEqual([
    NaN,
    NaN,
    Infinity,
    -Infinity,
  ])
  expect(() => numbers('NaN,1', 2, [1])).toThrow('time')
  expect(() => numbers('0,1,2', 2, [1])).toThrow('columns')
  expect(() => numbers('0,no', 2, [1])).toThrow('numeric')
  const { csv } = await fixture('t,x\n2,1\n1,2\n')
  await expect(csv.scan(true)).rejects.toThrow('decreases')
})
it('reads every sample through exact blocks while keeping its sparse index bounded', async () => {
  const { csv, path } = await fixture('t,a,b\n')
  const file = await open(path, 'a')
  for (let batch = 0; batch < 100; batch++) {
    let chunk = ''
    for (let i = batch * 1000; i < (batch + 1) * 1000; i++)
      chunk += `${i},${i === 45678 ? 99 : 0},${i === 45679 ? -77 : 1}\n`
    await file.write(chunk)
  }
  await file.close()
  const info = await csv.scan(true)
  expect(info.rows).toBe(100000)
  expect(info.indexEntries).toBeLessThanOrEqual(8192)
  let count = 0
  let foundHigh = false
  let foundLow = false
  for (let frame = 0; frame < info.rows; frame += 2048) {
    const result = await csv.read(frame, Math.min(2048, info.rows - frame), [1, 2])
    expect(result.time[0]).toBe(frame)
    count += result.time.length
    foundHigh ||= result.values.includes(99)
    foundLow ||= result.values.includes(-77)
  }
  expect(count).toBe(100000)
  expect(foundHigh && foundLow).toBe(true)
  const narrow = await csv.read(45677, 4, [1, 2])
  expect([...narrow.time]).toEqual([45677, 45678, 45679, 45680])
  const abort = new AbortController()
  abort.abort()
  await expect(csv.read(4000, 1, [1], abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
it('maps whole headers, including underscores and duplicate names, with exact occurrence counts', () => {
  const text = caseText({
    buses: [
      { number: 1, name: 'same_name', mon: ['Vm', 'Vr'] },
      { number: 2, name: 'same_name', mon: ['Vr', 'Vm'] },
    ],
  })
  const raw = validate(JSON.parse(text))
  const model = parse(new TextEncoder().encode(text)).model
  const bound = bindColumns(raw, model, [
    't',
    'Bus_same_name_Vr',
    'Bus_same_name_Vm',
    'Bus_same_name_Vr',
    'Bus_same_name_Vm',
  ])
  expect(bound.map((column) => [column.field.id, column.element])).toEqual([
    ['Vr', 0],
    ['Vm', 0],
    ['Vr', 1],
    ['Vm', 1],
  ])
  expect(() => bindColumns(raw, model, ['t', 'Bus_same_name_Vm'])).toThrow('unambiguously')
  expect(() => bindColumns(raw, model, ['t', 'Bus_other_Vm'])).toThrow('unambiguously')
})

it('extends exact signal ranges across appends and ignores missing samples', async () => {
  const { csv, path } = await fixture('t,a,b\n0,1,nan\n1,2,8\n')
  await csv.scan(false)
  expect(await csv.extent([1])).toEqual([1, 2])
  expect(await csv.extent([2])).toEqual([8, 8])
  await appendFile(path, '2,-10,3\n3,6,100\n')
  await csv.scan(true)
  expect(await csv.extent([1])).toEqual([-10, 6])
  expect(await csv.extent([2])).toEqual([3, 100])
  const controller = new AbortController()
  controller.abort()
  await expect(csv.extent([1], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
it("opens known CSV signals independently of the case's current monitoring choices", () => {
  const text = caseText({ buses: [{ number: 1, name: 'bus_1', mon: [] }] })
  const model = parse(new TextEncoder().encode(text)).model
  const raw = validate(JSON.parse(text))
  expect(bindColumns(raw, model, ['t', 'Bus_bus_1_Vm'], false)).toEqual([
    { column: 1, field: { classId: 'bus', source: 'signal', id: 'Vm' }, element: 0 },
  ])
  expect(() => bindColumns(raw, model, ['t', 'Bus_bus_1_Vm'])).toThrow('unambiguously')
})

it("maps infinite bus samples using GridKit's common Bus header prefix", () => {
  const text = caseText({
    buses: [{ number: 1, class: 'BusInfinite', name: 'infinite', mon: ['va'] }],
  })
  const raw = validate(JSON.parse(text))
  const model = parse(new TextEncoder().encode(text)).model
  expect(bindColumns(raw, model, ['t', 'Bus_infinite_Va'])).toEqual([
    { column: 1, field: { classId: 'bus', source: 'signal', id: 'Va' }, element: 0 },
  ])
})
