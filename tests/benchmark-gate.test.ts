import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

it('fails qualifying regressions, filters busy rounds, and keeps native counters independent', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'studio-benchmark-gate-'))
  const base = join(folder, 'base.json')
  const head = join(folder, 'head.json')
  const busy = join(folder, 'busy.json')
  const report = (time: number, canary: number, renderer: string) => ({
    gridkit: 'same-build',
    renderer,
    timings: {
      'network 39 buses > open': [time, time + 1, time + 2],
      'machine 39 buses > canary': [canary],
    },
    work: { 'network 39 buses > open': { uploaded: renderer === 'native' ? 100 : 1 } },
  })
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['tests/benchmarks/compare.mjs', ...args], { encoding: 'utf8' })
  try {
    await writeFile(base, JSON.stringify(report(100, 100, 'previous')))
    await writeFile(head, JSON.stringify(report(131, 100, 'native')))
    const regression = run(base, head)
    expect(regression.status).toBe(1)
    expect(regression.stdout).toContain('slower network 39 buses > open')
    expect(regression.stdout).not.toContain('work network')
    await writeFile(head, JSON.stringify(report(120, 100, 'native')))
    expect(run(base, head).status).toBe(0)
    expect(run(join(folder, 'missing.json'), head).status).toBe(1)
    await writeFile(busy, JSON.stringify(report(1000, 200, 'native')))
    const filtered = run(base, '--', head, busy)
    expect(filtered.status).toBe(0)
    expect(filtered.stdout).toContain('left out')
    const inconclusive = run(base, base, base, '--', busy)
    expect(inconclusive.status).toBe(1)
    expect(inconclusive.stdout).toContain('no unfiltered comparison')
    await writeFile(
      head,
      JSON.stringify({ ...report(100, 100, 'native'), gridkit: 'different-build' }),
    )
    expect(run(base, head).status).toBe(1)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
