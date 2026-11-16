/**
 * Compares benchmark runs from views.ts and fails on timing regressions:
 *   node tests/benchmarks/compare.mjs base.json head.json
 *   node tests/benchmarks/compare.mjs base-1.json base-2.json -- head-1.json head-2.json
 *   node tests/benchmarks/compare.mjs head.json
 * Rounds whose canaries ran over 15% slower than their quickest are skipped, and each scenario is
 * the median of round medians. Work counters are compared only on the same renderer, and timings
 * only on the same GridKit build. Also reports superlinear time per bus.
 */
import { readFileSync } from 'node:fs'

const SLOWER = 1.25
const SLACK_MS = 5
/** Canary slowdown, relative to its quickest round, past which a case's round is skipped. */
const BUSY = 1.15
// Fixed costs inflate the smallest case per bus; quadratic work would still grow 250x from 39 buses
// to 10,000.
const SUPERLINEAR = 3
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const sizeOf = (name) => /(\d+) buses/.exec(name)?.[1]
/** Scenarios that measure the machine rather than Studio. */
const canaries = (size) => [
  `simulation ${size} buses > simulate 1 s`,
  `machine ${size} buses > canary`,
]
/** A canary's slowest sample, since one slow stretch affects the whole case. */
const canary = (run, name) => {
  const samples = run.timings[name]
  return samples?.length ? Math.max(...samples) : undefined
}

function quickestOf(runs) {
  const quickest = new Map()
  for (const run of runs)
    for (const name of Object.keys(run.timings)) {
      const size = sizeOf(name)
      if (!size) continue
      for (const each of canaries(size)) {
        if (quickest.has(each)) continue
        const times = runs.map((round) => canary(round, each)).filter(Number.isFinite)
        if (times.length) quickest.set(each, Math.min(...times))
      }
    }
  return quickest
}

const busy = (run, size, quickest) =>
  canaries(size).some((name) => canary(run, name) > BUSY * quickest.get(name))

/** Merges rounds, skipping busy ones: each scenario's median of medians, plus its lowest sample so
 *  a run counts as slower only when both its best and typical times are. */
function pooled(runs, quickest) {
  const medians = {}
  const lowest = {}
  let skipped = 0
  for (const run of runs)
    for (const [name, samples] of Object.entries(run.timings)) {
      const size = sizeOf(name)
      if (size && busy(run, size, quickest)) {
        skipped++
        continue
      }
      ;(medians[name] ??= []).push(median(samples))
      ;(lowest[name] ??= []).push(Math.min(...samples))
    }
  return {
    gridkit: runs.map((run) => run.gridkit),
    skipped,
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
const baseRuns = basePaths.map(read)
const quickest = quickestOf([...baseRuns, ...headRuns])
const head = pooled(headRuns, quickest)
const base = baseRuns.length ? pooled(baseRuns, quickest) : undefined
const lines = []

for (const [side, run] of [
  ['base', base],
  ['head', head],
])
  if (run?.skipped)
    lines.push(`${side}: ${run.skipped} timings left out, taken while the machine ran slow`)

const builds = new Set([...(base?.gridkit ?? []), ...head.gridkit].filter(Boolean))
if (builds.size > 1) {
  process.exitCode = 1
  lines.push(`GridKit builds differ, so no timing is compared: ${[...builds].join(', ')}`)
} else if (base) {
  const common = new Set(baseRuns.flatMap((run) => Object.keys(run.timings)))
  const unmeasured = [...common].filter(
    (name) =>
      headRuns.some((run) => name in run.timings) && (!base.timings[name] || !head.timings[name]),
  )
  if (unmeasured.length) {
    process.exitCode = 1
    lines.push(`inconclusive: ${unmeasured.length} shared scenarios have no unfiltered comparison`)
  }
  const slower = (now, before) => now > before * SLOWER + SLACK_MS
  for (const [name, now] of Object.entries(head.timings)) {
    const before = base.timings[name]
    if (before && slower(now.lowest, before.lowest) && slower(now.median, before.median)) {
      process.exitCode = 1
      lines.push(`slower ${name}: ${before.median.toFixed(1)} → ${now.median.toFixed(1)} ms`)
    }
  }
}
if (base && baseRuns.at(-1).renderer === headRuns.at(-1).renderer)
  for (const [name, counters] of Object.entries(head.work ?? {}))
    for (const [counter, value] of Object.entries(counters)) {
      const before = base.work?.[name]?.[counter]
      if (before !== undefined && before !== value)
        lines.push(`work ${name}: ${counter} ${before} → ${value}`)
    }

const scaled = new Map()
for (const [name, { median: time }] of Object.entries(head.timings)) {
  // Names look like `network 2000 buses > select`.
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
