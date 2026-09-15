import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { collect, sample, validateSeries } from '@latkit/model'
import { loopback, settle } from '@latkit/port/testing'
import { connectResults, serveResults } from '@latkit/remote'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'

import { CHUNK_BYTES, decoder, header } from '../src/csv/decode.js'
import { CsvSource } from '../src/csv/source.js'
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

it('locates every duplicate across sparse index entries within the captured head', async () => {
  const { csv, path } = await fixture(
    't,a\n' +
      Array.from({ length: 900 }, (_, i) => (i < 200 ? 0 : i < 800 ? 1 : 2) + ',' + i + '\n').join(
        '',
      ),
  )
  await csv.scan(false)
  expect(await csv.bounds([1, 1], 900)).toEqual([200, 800])
  expect(await csv.bounds([1, 1], 500)).toEqual([200, 500])
  expect(await csv.bounds([-1, -1], 900)).toEqual([0, 0])
  expect(await csv.bounds([3, 3], 900)).toEqual([900, 900])
  await appendFile(path, '2,900\n3,901\n')
  await csv.scan(true)
  expect(await csv.bounds([2, 3], 900)).toEqual([800, 900])
  expect(await csv.bounds([2, 3], 902)).toEqual([800, 902])
  await expect(csv.bounds([0, 3], 902, AbortSignal.abort())).rejects.toMatchObject({
    name: 'AbortError',
  })
})

it('serves sparse f64 series from the real worker and publishes committed appends', async () => {
  const { path } = await fixture('t,a,b\n0,1000000000000.125,8\n1,1000000000000.25,9\n')
  const worker = join(dirname(path), 'worker.cjs')
  await build({
    entryPoints: [resolve('src/csv/worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  })
  const csv = new CsvSource(path, worker)
  cleanup.push(() => csv.dispose())
  await csv.scan(false)
  csv.columns = [
    { column: 1, field: { classId: 'bus', source: 'signal', id: 'Vm' }, element: 3 },
    { column: 2, field: { classId: 'bus', source: 'signal', id: 'Va' }, element: 90000 },
  ]
  const series = await csv.series('bus')
  expect(await csv.series('bus')).toBe(series)
  expect(series.elements).toEqual(Uint32Array.of(3, 90000))
  const before = series.state
  const window = { frameOffset: 0, frameCount: 2, elementOffset: 0, elementCount: 2 }
  const block = await series.read(0, window)
  expect(block.values).toEqual(Float64Array.of(1e12 + 0.125, NaN, 1e12 + 0.25, NaN))
  expect((await series.read(1, window)).values).toEqual(Float64Array.of(NaN, 8, NaN, 9))
  expect((await series.read(0, { ...window, elementCount: 0 })).time).toEqual(Float64Array.of(0, 1))
  let appends = 0
  const off = series.on('append', () => appends++)
  await appendFile(path, '1,1000000000000.5,10\n')
  await csv.scan(false)
  await csv.scan(false)
  expect(appends).toBe(1)
  expect(before.frameCount).toBe(2)
  expect(series.state.frameCount).toBe(3)
  expect(await series.locate([1, 1], 2)).toEqual([1, 2])
  expect(await series.locate([1, 1], 3)).toEqual([1, 3])
  const batches = []
  for await (const batch of csv.read('bus', [1, 0])) batches.push(batch)
  expect(batches[0]).toMatchObject({
    resultId: csv.id,
    elements: Uint32Array.of(3, 90000),
    signalCount: 2,
  })
  expect([...batches[0].values].slice(0, 4)).toEqual([NaN, 8, 1e12 + 0.125, NaN])
  await expect(series.read(0, window, AbortSignal.abort())).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(() => {
    csv.columns = []
  }).toThrow(/cannot change/)
  off()
})

it('streams CSV results through the released remote protocol without losing sparse indices or f64 samples', async () => {
  const { path } = await fixture('t,a,b\n')
  const worker = join(dirname(path), 'worker.cjs')
  await build({
    entryPoints: [resolve('src/csv/worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  })
  const csv = new CsvSource(path, worker)
  cleanup.push(() => csv.dispose())
  await csv.scan(false)
  csv.columns = [
    { column: 1, field: { classId: 'bus', source: 'signal', id: 'Va' }, element: 90000 },
    { column: 2, field: { classId: 'bus', source: 'signal', id: 'Vm' }, element: 3 },
  ]
  const [host, page] = loopback()
  const stop = serveResults(host, csv, { maxBytes: 1024 })
  const results = connectResults(page, csv.id)
  cleanup.push(async () => {
    results.close()
    stop()
  })
  const series = await results.series('bus')
  validateSeries(series)
  expect(await results.series('bus')).toBe(series)
  expect(series.state).toEqual({ frameCount: 0, timeRange: null, ranges: null })
  expect(series.elements).toEqual(Uint32Array.of(3, 90000))
  const before = series.state
  let appends = 0
  series.on('append', () => appends++)
  await appendFile(path, '0,8,1000000000000.125\n1,9,1000000000000.25\n1,10,1000000000000.5\n')
  await csv.scan(false)
  await settle()
  validateSeries(series)
  expect(appends).toBe(1)
  expect(before.frameCount).toBe(0)
  expect(series.state.frameCount).toBe(3)
  expect(await series.locate([1, 1], 2)).toEqual([1, 2])
  expect(await series.locate([1, 1], 3)).toEqual([1, 3])
  const window = { frameOffset: 0, frameCount: 3, elementOffset: 0, elementCount: 2 }
  const local = await csv.series('bus')
  const borrowed = await local.read(1, window)
  expect(await series.read(1, window)).toEqual(borrowed)
  expect(await sample(series, 1, 1)).toEqual(Float64Array.of(1e12 + 0.25, NaN))
  const collected = await collect(results.read('bus', [1, 0]))
  expect(await sample(collected, 0, 0)).toEqual(Float64Array.of(1e12 + 0.125, NaN))
  expect(await sample(collected, 1, 2)).toEqual(Float64Array.of(NaN, 10))
  expect(collected.elements).toEqual(series.elements)
  const all = await collect(results.read('bus', null))
  expect(await sample(all, 0, 0)).toEqual(Float64Array.of(NaN, 8))
  expect(await sample(all, 1, 0)).toEqual(Float64Array.of(1e12 + 0.125, NaN))
  // Remote transfers must leave the worker's cached samples usable.
  expect((await local.read(1, window)).values).toBe(borrowed.values)
  expect(borrowed.values.byteLength).toBe(48)
  expect(borrowed.values[0]).toBe(1e12 + 0.125)
  await expect(series.read(1, window, AbortSignal.abort())).rejects.toMatchObject({
    name: 'AbortError',
  })
  await expect(series.read(2, window)).rejects.toThrow()
  await expect(series.read(1, { ...window, frameCount: 4 })).rejects.toThrow()
  await expect(results.series('missing')).rejects.toThrow(/not recorded/)
  results.close()
  await appendFile(path, '2,11,1000000000000.75\n')
  await csv.scan(false)
  await settle()
  expect(appends).toBe(1)
  expect(local.state.frameCount).toBe(4)
  await expect(series.read(1, window)).rejects.toThrow()
})

it('shares decoded committed frames across projections without transferring cached buffers', async () => {
  const { csv } = await fixture('t,a,b,c\n0,1.000000000000002,2,nan\n1,3,4,5\n')
  await csv.scan(true)
  const [a, b] = await Promise.all([csv.read(0, 1, [1, -1]), csv.read(0, 1, [2, 1, 2])])
  expect([...a.values]).toEqual([1.000000000000002, NaN])
  expect([...b.values]).toEqual([2, 1.000000000000002, 2])
  structuredClone(a, { transfer: [a.values.buffer as ArrayBuffer, a.time.buffer as ArrayBuffer] })
  expect([...(await csv.read(0, 1, [1, 3])).values]).toEqual([1.000000000000002, NaN])
})
it('keeps an oversized frame on the bounded projection path', async () => {
  const { path } = await fixture('t,a,b,c\n0,1,2,3\n')
  const csv = new CsvFile(path, 8)
  cleanup.push(() => csv.dispose())
  await csv.scan(true)
  expect([...(await csv.read(0, 1, [3, 1])).values]).toEqual([3, 1])
})
it('serves table queries beside Results in the CSV worker with sparse identities and committed heads', async () => {
  const { path } = await fixture(
    't,a,b\n0,1000000000000.125,7\n1,1000000000000.25,8\n1,1000000000000.5,9\n',
  )
  const worker = join(dirname(path), 'worker.cjs')
  await build({
    entryPoints: [resolve('src/csv/worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  })
  const csv = new CsvSource(path, worker)
  cleanup.push(() => csv.dispose())
  csv.columns = [
    { column: 1, field: { classId: 'bus', source: 'signal', id: 'Vm' }, element: 3 },
    { column: 2, field: { classId: 'bus', source: 'signal', id: 'Vm' }, element: 0 },
  ]
  await csv.scan(true)
  const table = await csv.openTable(
    { labels: ['A', 'B', 'C', 'D'], columns: [] },
    csv.signals('bus'),
  )
  const series = await csv.series('bus')
  const earlier = await table.query({
    filter: '',
    sort: { column: '@signal:Vm', dir: 'asc' },
    time: 1,
    frameCount: 2,
  })
  expect(earlier.frame).toBe(1)
  const block = await earlier.read(0, 4, [0])
  expect(block.rows.map((row) => [row.index, row.cells[0]])).toEqual([
    [0, '8'],
    [3, '1000000000000.25'],
    [1, ''],
    [2, ''],
  ])
  const latest = await table.query({
    filter: '1000000000000.5',
    sort: null,
    time: 1,
    frameCount: 3,
  })
  expect(await latest.locate(3)).toBe(0)
  expect((await earlier.read(0, 1, [0])).rows[0].cells).toEqual(['8'])
  const values = await series.read(0, {
    frameOffset: 1,
    frameCount: 1,
    elementOffset: 0,
    elementCount: 2,
  })
  expect([...values.values]).toEqual([8, 1000000000000.25])
  earlier.close()
  latest.close()
  table.close()
  expect([
    ...(await series.read(0, { frameOffset: 2, frameCount: 1, elementOffset: 0, elementCount: 2 }))
      .values,
  ]).toEqual([9, 1000000000000.5])
  const reopened = await csv.openTable(
    { labels: ['A', 'B', 'C', 'D'], columns: [] },
    csv.signals('bus'),
  )
  const view = await reopened.query({ filter: '', sort: null, frame: 0, frameCount: 3 })
  expect((await view.read(3, 1, [0])).rows[0].cells).toEqual(['1000000000000.125'])
  reopened.close()
})

it('keeps the table field order independent of CSV and Results signal order', async () => {
  const { path } = await fixture('t,b,a\n0,22,11\n')
  const worker = join(dirname(path), 'worker.cjs')
  await build({
    entryPoints: [resolve('src/csv/worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  })
  const csv = new CsvSource(path, worker)
  cleanup.push(() => csv.dispose())
  const a = { classId: 'bus', source: 'signal' as const, id: 'a' }
  const b = { classId: 'bus', source: 'signal' as const, id: 'b' }
  csv.columns = [
    { column: 1, field: b, element: 0 },
    { column: 2, field: a, element: 0 },
  ]
  await csv.scan(true)
  const table = await csv.openTable({ labels: ['bus'], columns: [] }, [a, b])
  const view = await table.query({ filter: '', sort: null, frame: 0 })
  expect((await view.read(0, 1, [0, 1])).rows[0].cells).toEqual(['11', '22'])
  expect(() => {
    csv.columns = []
  }).toThrow('cannot change')
  table.close()
})
