/**
 * The benchmark regression gate for views.ts.
 *
 *   node tests/benchmarks/gate.mjs base.json head.json   check head's work against work.json
 *   node tests/benchmarks/gate.mjs --update head.json    record head's work as work.json, and its
 *                                                        timings in the README
 *
 * It fails only when exact work per run grows. Timings vary between runs, even on one machine, so
 * it reports, without failing, scenarios slower than the base and time per bus that grows faster
 * than linearly across the cases.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SLOWER = 1.25
const SLACK_MS = 5
// Fixed costs make the smallest case dear per bus; quadratic work would still grow 250 times from
// 39 buses to 10,000.
const SUPERLINEAR = 3
const committed = new URL('./work.json', import.meta.url)
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]

if (process.argv[2] === '--update') {
  const { work } = read(process.argv[3])
  const sorted = Object.fromEntries(Object.entries(work).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(committed, JSON.stringify(sorted, null, 2) + '\n')
  console.log('Recorded work for ' + Object.keys(work).length + ' scenarios.')
  readme(read(process.argv[3]).timings)
  process.exit(0)
}

/** The README's performance table, between its markers: each case's median per scenario. */
function readme(timings) {
  const CASES = { 39: 'IEEE39', 243: 'WECC240', 2000: 'ACTIVSg2000', 10000: 'ACTIVSg10k' }
  const SCENARIOS = ['first frame', 'restyle', 'camera move', 'labels', 'simulate 1 s']
  const ms = (name) => {
    const samples = timings[name]
    return samples ? Math.round(median(samples)).toLocaleString('en-US') + ' ms' : '—'
  }
  const rows = Object.entries(CASES).map(([buses, name]) => [
    name,
    Number(buses).toLocaleString('en-US'),
    ...SCENARIOS.map((scenario) => ms(`network ${buses} buses > ${scenario}`)),
  ])
  const head = ['Case', 'Buses', 'First frame', 'Restyle', 'Camera move', 'Labels', 'Simulate 1 s']
  const widths = head.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i].length)))
  const line = (cells) =>
    '| ' +
    cells
      .map((cell, i) => (i < 1 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join(' | ') +
    ' |'
  const rule =
    '| ' +
    widths
      .map((width, i) => (i < 1 ? '-'.repeat(width) : '-'.repeat(width - 1) + ':'))
      .join(' | ') +
    ' |'
  const table = [line(head), rule, ...rows.map(line)].join('\n')
  const path = new URL('../../README.md', import.meta.url)
  const text = readFileSync(path, 'utf8')
  const [start, end] = ['<!-- bench -->', '<!-- /bench -->']
  if (!text.includes(start) || !text.includes(end))
    throw new Error('The README has no benchmark markers.')
  writeFileSync(
    path,
    text.slice(0, text.indexOf(start) + start.length) +
      '\n' +
      table +
      '\n' +
      text.slice(text.indexOf(end)),
  )
  console.log('Wrote the README benchmark table.')
}

const [basePath, headPath] = process.argv.slice(2)
const head = read(headPath)
const failures = []
const notes = []
const timed = []

// 1. Exact work per run may not grow.
const expected = existsSync(committed) ? read(committed) : {}
for (const [name, counters] of Object.entries(expected)) {
  const now = head.work[name]
  if (!now) {
    notes.push('no work recorded: ' + name)
    continue
  }
  for (const [counter, value] of Object.entries(counters)) {
    const current = now[counter] ?? 0
    if (current > value) failures.push(`work ${name}: ${counter} ${value} → ${current}`)
    else if (current < value) notes.push(`less work ${name}: ${counter} ${value} → ${current}`)
  }
}
for (const name of Object.keys(head.work))
  if (!expected[name]) notes.push('new scenario without recorded work: ' + name)

// 2. Time against the base, measured back to back on the same machine. Noise rarely slows both
// the fastest and the median run.
if (basePath && existsSync(basePath)) {
  const base = read(basePath).timings
  const slower = (now, before) => now > before * SLOWER + SLACK_MS
  for (const [name, samples] of Object.entries(head.timings)) {
    const before = base[name]
    if (
      before &&
      slower(Math.min(...samples), Math.min(...before)) &&
      slower(median(samples), median(before))
    )
      timed.push(`slower ${name}: ${median(before).toFixed(1)} → ${median(samples).toFixed(1)} ms`)
  }
} else notes.push('no base timings; skipped the comparison against the base')

// 3. Time per bus may grow at most SUPERLINEAR times from the smallest case to the largest.
const scaled = new Map()
for (const [name, samples] of Object.entries(head.timings)) {
  // Groups are named `<view> <size> buses`, such as `network 2000 buses`.
  const match = /^(.*?) (\d+) buses > (.*)$/.exec(name)
  if (!match) continue
  const key = `${match[1]} > ${match[3]}`
  const size = Number(match[2])
  scaled.set(key, [...(scaled.get(key) ?? []), { size, perBus: median(samples) / size }])
}
for (const [name, points] of scaled) {
  if (points.length < 2) continue
  points.sort((a, b) => a.size - b.size)
  if (points.at(-1).perBus > points[0].perBus * SUPERLINEAR)
    timed.push(
      `superlinear ${name}: ${points.map(({ perBus }) => (perBus * 1e3).toFixed(1)).join(' → ')} µs per bus`,
    )
}

for (const note of notes) console.log(note)
if (timed.length) console.log('Timings to check by hand; single runs vary:\n' + timed.join('\n'))
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(
  `Benchmarks pass: ${Object.keys(head.timings).length} timed, ${Object.keys(expected).length} with recorded work.`,
)
