import assert from 'node:assert/strict'
import { copyFile, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { bindColumns } from '../../src/csv/columns.js'
import { CsvSource } from '../../src/csv/source.js'
import { parse } from '../../src/gridkit/parse.js'
import { resolveSolver } from '../../src/launch.js'
import { executeSolver, simulationCommand } from '../../src/runtime.js'
import { appendFault } from '../../src/simulation/faults.js'
const options = { method: 'auto', executable: '' } as const
const root = await mkdtemp(join(tmpdir(), 'gridkit solver test '))
let csv: CsvSource | undefined
try {
  for (const file of ['two-bus.case.json', 'two-bus.solver.json'])
    await copyFile(resolve('tests/fixtures/solver', file), join(root, file))
  const before = await readFile(join(root, 'two-bus.case.json'))
  const launch = await resolveSolver(join(root, 'two-bus.solver.json'), root)
  const execution = executeSolver(await simulationCommand(launch, options), (_stream, text) =>
    process.stdout.write(text),
  )
  assert.equal(await execution.done, 0)
  csv = new CsvSource(launch.output, resolve('dist/csv/worker.cjs'))
  const info = await csv.scan(true)
  assert.ok(info.rows > 400)
  csv.columns = bindColumns(launch.raw, parse(before).model, info.headers)
  const field = csv.columns[0].field
  const elements = csv.columns
    .filter((column) => column.field.classId === field.classId && column.field.id === field.id)
    .map((column) => column.element)
  const source = await csv.series(field.classId)
  const series = await source.read(
    csv.signals(field.classId).findIndex((s) => s.id === field.id),
    {
      frameOffset: 0,
      frameCount: info.rows,
      elementOffset: 0,
      elementCount: source.elementCount,
    },
  )
  assert.equal(series.time.length, info.rows)
  const frame = await csv.cellsAt(await csv.locate(1), [field], [elements[0]])
  assert.ok(Number.isFinite(frame[0]))
  assert.deepEqual(await readFile(join(root, 'two-bus.case.json')), before)
  assert.deepEqual((await readdir(root)).sort(), [
    'mon.csv',
    'two-bus.case.json',
    'two-bus.solver.json',
  ])
  const authored = appendFault(before.toString(), launch.raw, launch.raw.buses[0].number, 0, 1)
  await writeFile(join(root, 'authored.case.json'), authored.text)
  await writeFile(
    join(root, 'authored.solver.json'),
    JSON.stringify({
      system_model_file: 'authored.case.json',
      tmax: 0.1,
      dt_monitor: 0.01,
      events: [
        { time: 0.02, type: 'fault_on', element_id: authored.index },
        { time: 0.03, type: 'fault_off', element_id: authored.index },
      ],
    }),
  )
  const authoredLaunch = await resolveSolver(join(root, 'authored.solver.json'), root)
  assert.equal(
    await executeSolver(await simulationCommand(authoredLaunch, options), (_stream, text) =>
      process.stdout.write(text),
    ).done,
    0,
  )
  console.log('PASS authored named fault with declaration index and real-valued impedance')
  const widePath = join(root, 'wide.csv')
  const file = await open(widePath, 'w')
  const elementCount = 4096
  const frameCount = 513
  const columns = Array.from({ length: elementCount * 2 }, (_, i) => `v${i}`)
  await file.write(`t,${columns.join(',')}\n`)
  for (let frame = 0; frame < frameCount; frame++) {
    const row = Array.from({ length: elementCount * 2 }, (_, i) =>
      i === elementCount - 1 && frame === 257 ? 'nan' : String(frame * 10000 + i),
    )
    await file.write(`${Math.floor(frame / 2) / 10},${row.join(',')}\n`)
  }
  await file.close()
  await csv.dispose()
  csv = new CsvSource(widePath, resolve('dist/csv/worker.cjs'))
  await csv.scan(true)
  const fields = ['a', 'b'].map((id) => ({ classId: 'bus', source: 'signal' as const, id }))
  csv.columns = columns.map((_, i) => ({
    column: i + 1,
    element: i % elementCount,
    field: fields[Math.floor(i / elementCount)],
  }))
  const started = performance.now()
  const initialMemory = process.memoryUsage().rss
  let peakMemory = initialMemory
  let samples = 0
  for (const field of fields) {
    const source = await csv.series(field.classId)
    for (let offset = 0; offset < frameCount; offset += 32) {
      const count = Math.min(32, frameCount - offset)
      const block = await source.read(
        csv.signals(field.classId).findIndex((s) => s.id === field.id),
        {
          frameOffset: offset,
          frameCount: count,
          elementOffset: 0,
          elementCount,
        },
      )
      samples += block.values.length
      peakMemory = Math.max(peakMemory, process.memoryUsage().rss)
      assert.equal(block.time[0], Math.floor(offset / 2) / 10)
      assert.equal(
        block.values[elementCount - 1],
        offset * 10000 + elementCount - 1 + (field.id === 'b' ? elementCount : 0),
      )
    }
  }
  assert.equal(samples, elementCount * frameCount * 2)
  const event = await csv.locate(12.8)
  assert.equal(event, 257)
  const values = await csv.cellsAt(event, fields, [elementCount - 1])
  assert.ok(Number.isNaN(values[0]))
  assert.equal(values[1], 257 * 10000 + elementCount * 2 - 1)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(
    (await csv.series(fields[0].classId)).read(
      0,
      { frameOffset: 0, frameCount: 32, elementOffset: 0, elementCount },
      abort.signal,
    ),
    { name: 'AbortError' },
  )
  console.log(
    `PASS exact CSV samples: ${samples.toLocaleString()} samples, ${elementCount} traces per field, ${(performance.now() - started).toFixed(0)} ms, ${((peakMemory - initialMemory) / 1048576).toFixed(1)} MiB peak RSS increase`,
  )
  console.log(
    `PASS DynamicSimulation, CSV (${info.rows} rows), worker reads, paths with spaces, and no copied run artifacts`,
  )
} finally {
  await csv?.dispose()
  await rm(root, { recursive: true, force: true })
}
