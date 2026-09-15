import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const root = resolve('output/table-benchmark')
await mkdir(root, { recursive: true })
for (const [entry, name] of [
  ['src/table/engine.ts', 'engine'],
  ['src/csv/worker.ts', 'csv'],
])
  await build({
    entryPoints: [entry],
    outfile: join(root, name + '.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
const { TableEngine } = await import(pathToFileURL(join(root, 'engine.mjs')))
const { CsvFile } = await import(pathToFileURL(join(root, 'csv.mjs')))
const measure = async (fn) => {
  const start = performance.now()
  const value = await fn()
  return { ms: performance.now() - start, value }
}
const median = async (fn) => {
  const times = []
  for (let i = 0; i < 15; i++) times.push((await measure(fn)).ms)
  return times.sort((a, b) => a - b)[7]
}
const results = []
for (const [rows, columns] of [
  [10000, 8],
  [100000, 8],
  [1000000, 8],
  [100000, 64],
]) {
  const data = {
    labels: Array.from({ length: rows }, (_, i) => 'Bus ' + i),
    columns: Array.from({ length: columns }, (_, j) => ({
      kind: 'number',
      id: 'c' + j,
      label: 'Column ' + j,
      values: Float64Array.from(
        { length: rows },
        (_, i) => ((i * 7919 + j * 13) % rows) + 0.123456789,
      ),
    })),
  }
  const table = new TableEngine(data)
  const projected = Array.from({ length: Math.min(columns, 8) }, (_, i) => i)
  const sort = { column: 'c0', dir: 'asc' }
  const window = async (filter, sort, offset = 0) => {
    const view = await table.query({ filter, sort })
    try {
      return await view.read(offset, 40, projected)
    } finally {
      view.close()
    }
  }
  const natural = await measure(() => window('', null))
  const sorted = await measure(() => window('', sort))
  const filtered = await measure(() => window('bus', sort))
  const view = await table.query({ filter: 'bus', sort })
  await view.locate(rows - 1)
  const result = {
    rows,
    columns,
    projected: projected.length,
    naturalColdMs: natural.ms,
    sortColdMs: sorted.ms,
    filterColdMs: filtered.ms,
    naturalWarmMs: await median(() => window('', null)),
    sortWarmMs: await median(() => window('', sort)),
    filterSortWarmMs: await median(() => window('bus', sort)),
    locateWarmMs: await median(() => view.locate(rows - 1)),
    payloadBytes: Buffer.byteLength(JSON.stringify(natural.value)),
  }
  view.close()
  table.close()
  results.push(result)
  console.log(JSON.stringify(result))
}
const temp = await mkdtemp(join(tmpdir(), 'gridkit-table-bench-'))
try {
  const path = join(temp, 'wide.csv')
  const width = 200000
  await writeFile(
    path,
    't,' +
      Array.from({ length: width }, (_, i) => 'c' + i).join(',') +
      '\n0,' +
      Array.from({ length: width }, (_, i) => i + 0.123456789).join(',') +
      '\n',
  )
  const csv = new CsvFile(path)
  try {
    await csv.scan(true)
    const columns = Array.from({ length: 2048 }, (_, i) => i + 1)
    const first = await measure(() => csv.read(0, 1, columns))
    const projected = await measure(async () => {
      for (let offset = 0; offset < width; offset += 2048)
        await csv.read(
          0,
          1,
          columns.slice(0, Math.min(2048, width - offset)).map((column) => column + offset),
        )
    })
    results.push({
      csvColumns: width,
      firstReadMs: first.ms,
      allProjectedBatchesWarmMs: projected.ms,
    })
    console.log(JSON.stringify(results.at(-1)))
  } finally {
    await csv.dispose()
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2) + '\n')
