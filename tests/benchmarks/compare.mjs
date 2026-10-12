/**
 * Compares runs of the benchmarks in views.ts, for a person to read. It never fails: timings vary
 * between runs, even on one machine, and work counters change with every renderer release.
 *
 *   node tests/benchmarks/compare.mjs base.json head.json
 *   node tests/benchmarks/compare.mjs base-1.json base-2.json -- head-1.json head-2.json
 *   node tests/benchmarks/compare.mjs head.json
 *
 * Each side may be several rounds, best alternated with the other's. A case's round whose own
 * GridKit simulation took half again as long as its usual ran on a busy machine, and is left out.
 * Each scenario is then the median of the rounds' medians. Runs on different GridKit builds are not
 * compared.
 *
 * It reports scenarios slower than the base, work that changed, and time per bus that grows faster
 * than linearly across the cases.
 */
import { existsSync, readFileSync } from 'node:fs'

const SLOWER = 1.25
const SLACK_MS = 5
/** How much longer than its usual a case's simulation may take before its round is left out. */
const BUSY = 1.5
// Fixed costs make the smallest case dear per bus; quadratic work would still grow 250 times from
// 39 buses to 10,000.
const SUPERLINEAR = 3
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const sizeOf = (name) => /(\d+) buses/.exec(name)?.[1]
const simulation = (run, size) => run.timings[`simulation ${size} buses > simulate 1 s`]?.[0]

/** How long each case's simulation usually took, over every round of both sides: the machine's
 *  usual pace, which no one side's busy rounds set. */
function usualOf(runs) {
  const usual = new Map()
  for (const run of runs)
    for (const name of Object.keys(run.timings)) {
      const size = sizeOf(name)
      if (!size || usual.has(size)) continue
      const times = runs.map((each) => simulation(each, size)).filter(Number.isFinite)
      if (times.length) usual.set(size, median(times))
    }
  return usual
}

/** The rounds' timings as one run: each scenario the median of its rounds' medians, over the rounds
 *  in which its case's simulation took its `usual` time. The lowest sample of every round is kept
 *  too, so a run is slower only when both its best and its typical times are. */
function pooled(runs, usual) {
  const medians = {}
  const lowest = {}
  let left = 0
  for (const run of runs)
    for (const [name, samples] of Object.entries(run.timings)) {
      const size = sizeOf(name)
      const time = size && simulation(run, size)
      if (Number.isFinite(time) && time > BUSY * usual.get(size)) {
        left++
        continue
      }
      ;(medians[name] ??= []).push(median(samples))
      ;(lowest[name] ??= []).push(Math.min(...samples))
    }
  return {
    gridkit: runs.map((run) => run.gridkit),
    left,
    work: runs.at(-1).work,
    timings: Object.fromEntries(
      Object.entries(medians).map(([name, values]) => [
        name,
        { median: median(values), lowest: Math.min(...lowest[name]) },
      ]),
    ),
  }
}

const args = process.argv.slice(2)
const split = args.indexOf('--')
const [basePaths, headPaths] =
  split >= 0
    ? [args.slice(0, split), args.slice(split + 1)]
    : [args.length > 1 ? [args[0]] : [], [args.at(-1)]]
const headRuns = headPaths.map(read)
const baseRuns = basePaths.filter((path) => existsSync(path)).map(read)
const usual = usualOf([...baseRuns, ...headRuns])
const head = pooled(headRuns, usual)
const base = baseRuns.length ? pooled(baseRuns, usual) : undefined
const lines = []

for (const [side, run] of [
  ['base', base],
  ['head', head],
])
  if (run?.left) lines.push(`${side}: ${run.left} timings left out, taken while GridKit ran slow`)

const builds = new Set([...(base?.gridkit ?? []), ...head.gridkit].filter(Boolean))
if (builds.size > 1)
  lines.push(`GridKit builds differ, so no timing is compared: ${[...builds].join(', ')}`)
else if (base) {
  const slower = (now, before) => now > before * SLOWER + SLACK_MS
  for (const [name, now] of Object.entries(head.timings)) {
    const before = base.timings[name]
    if (before && slower(now.lowest, before.lowest) && slower(now.median, before.median))
      lines.push(`slower ${name}: ${before.median.toFixed(1)} → ${now.median.toFixed(1)} ms`)
  }
}
if (base)
  for (const [name, counters] of Object.entries(head.work ?? {}))
    for (const [counter, value] of Object.entries(counters)) {
      const before = base.work?.[name]?.[counter]
      if (before !== undefined && before !== value)
        lines.push(`work ${name}: ${counter} ${before} → ${value}`)
    }

const scaled = new Map()
for (const [name, { median: time }] of Object.entries(head.timings)) {
  // Groups are named `<area> <size> buses`, such as `network 2000 buses` or `playback 39 buses`.
  const match = /^(.*?) (\d+) buses > (.*)$/.exec(name)
  if (!match) continue
  const key = `${match[1]} > ${match[3]}`
  scaled.set(key, [
    ...(scaled.get(key) ?? []),
    { size: Number(match[2]), perBus: time / Number(match[2]) },
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
