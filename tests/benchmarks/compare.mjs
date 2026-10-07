/**
 * Compares two runs of the benchmarks in views.ts, for a person to read. It never fails: timings
 * vary between runs, even on one machine, and work counters change with every renderer release.
 *
 *   node tests/benchmarks/compare.mjs base.json head.json
 *   node tests/benchmarks/compare.mjs head.json
 *
 * It reports scenarios slower than the base, work that changed, and time per bus that grows faster
 * than linearly across the cases.
 */
import { existsSync, readFileSync } from 'node:fs'

const SLOWER = 1.25
const SLACK_MS = 5
// Fixed costs make the smallest case dear per bus; quadratic work would still grow 250 times from
// 39 buses to 10,000.
const SUPERLINEAR = 3
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]

const paths = process.argv.slice(2)
const head = read(paths.at(-1))
const base = paths.length > 1 && existsSync(paths[0]) ? read(paths[0]) : undefined
const lines = []

if (base) {
  const slower = (now, before) => now > before * SLOWER + SLACK_MS
  for (const [name, samples] of Object.entries(head.timings)) {
    const before = base.timings[name]
    if (
      before &&
      slower(Math.min(...samples), Math.min(...before)) &&
      slower(median(samples), median(before))
    )
      lines.push(`slower ${name}: ${median(before).toFixed(1)} → ${median(samples).toFixed(1)} ms`)
  }
  for (const [name, counters] of Object.entries(head.work ?? {}))
    for (const [counter, value] of Object.entries(counters)) {
      const before = base.work?.[name]?.[counter]
      if (before !== undefined && before !== value)
        lines.push(`work ${name}: ${counter} ${before} → ${value}`)
    }
}

const scaled = new Map()
for (const [name, samples] of Object.entries(head.timings)) {
  // Groups are named `<area> <size> buses`, such as `network 2000 buses` or `playback 39 buses`.
  const match = /^(.*?) (\d+) buses > (.*)$/.exec(name)
  if (!match) continue
  const key = `${match[1]} > ${match[3]}`
  scaled.set(key, [
    ...(scaled.get(key) ?? []),
    { size: Number(match[2]), perBus: median(samples) / Number(match[2]) },
  ])
}
for (const [name, points] of scaled) {
  if (points.length < 2) continue
  points.sort((a, b) => a.size - b.size)
  if (points.at(-1).perBus > points[0].perBus * SUPERLINEAR)
    lines.push(
      `superlinear ${name}: ${points.map(({ perBus }) => (perBus * 1e3).toFixed(1)).join(' → ')} µs per bus`,
    )
}

console.log(
  lines.length
    ? lines.join('\n')
    : `${Object.keys(head.timings).length} scenarios timed${base ? '; nothing slower than the base' : ''}.`,
)
