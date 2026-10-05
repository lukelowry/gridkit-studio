/** View benchmarks inside VS Code, after latkit's: each scenario's time over RUNS, and its exact work
 *  per run, which tests/benchmarks/gate.mjs holds to tests/benchmarks/work.json. Each case's first
 *  open also checks that the canvas fills its editor, and geographic cases that borders draw. */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { pause, testHost } from '../vscode/harness.js'

/** Cases by bus count; the gate checks time per bus across them. */
const CASES = [
  ['tests/fixtures/IEEE39.case.json', 39],
  ['cases/WECC240.case.json', 243],
  ['cases/ACTIVSg2000.case.json', 2000],
  ['cases/ACTIVSg10k.case.json', 10000],
] as const
const RUNS = 5
/** Counters that only grow, compared per run. */
const WORK = [
  'queries',
  'uploads',
  'uploadedBytes',
  'allocations',
  'submissions',
  'evictions',
] as const
/** What the frame holds, compared as is. */
const SIZE = ['drawCalls', 'segments', 'geometryBytes', 'pickingBytes'] as const
type Stats = Record<(typeof WORK)[number] | (typeof SIZE)[number] | 'frames', number>
/** Work must not depend on timing: no hover search, easing, or motion. */
const STILL = { 'network.hover': 'off', 'network.animationMs': 0, 'accessibility.motion': 'reduce' }

export async function run() {
  const bench = await testHost()
  const settings = vscode.workspace.getConfiguration('gridkitStudio')
  const global = vscode.ConfigurationTarget.Global
  for (const [key, value] of Object.entries(STILL)) await settings.update(key, value, global)
  const timings: Record<string, number[]> = {}
  const work: Record<string, Record<string, number>> = {}
  const stages: Record<string, unknown> = {}
  try {
    for (const [path, buses] of CASES) {
      const group = `network ${buses} buses`
      let network!: Frame
      let uri!: vscode.Uri
      const stats = () => network.evaluate<Stats>('gridkitStats()')
      /** The next frame after `frames`, as soon as it draws. */
      const painted = (frames: number) =>
        network.waitForFunction('(frames) => gridkitStats().frames > frames', frames, {
          polling: 'raf',
          timeout: 60_000,
        })
      /** The counters once the view stops drawing. */
      async function settled(): Promise<Stats> {
        let last = await stats()
        for (;;) {
          await pause(250)
          const now = await stats()
          if (now.frames === last.frames) return now
          last = now
        }
      }

      const firsts: number[] = []
      for (let i = 0; i < RUNS; i++) {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        const start = performance.now()
        ;({ uri, network } = await bench.openCase(path))
        firsts.push(performance.now() - start)
      }
      timings[group + ' > first frame'] = firsts
      const page = await network.evaluate<{
        fills: boolean
        marks: Record<string, number>
      }>(`(() => {
        const rect = document.querySelector('canvas').getBoundingClientRect()
        return {
          fills: [rect.x, rect.y, rect.width - innerWidth, rect.height - innerHeight]
            .every((v) => Math.abs(v) < 1) && getComputedStyle(document.body).padding === '0px',
          marks: Object.fromEntries(performance.getEntriesByType('mark').map((e) => [e.name, e.startTime])),
        }
      })()`)
      assert.ok(page.fills, path + ': the canvas fills its editor')
      stages[group] = page.marks

      async function measure(scenario: string, act: (i: number) => unknown) {
        const samples: number[] = []
        const first = await settled()
        for (let i = 0; i < RUNS; i++) {
          const { frames } = await settled()
          const start = performance.now()
          await act(i)
          await painted(frames)
          samples.push(performance.now() - start)
        }
        const last = await settled()
        timings[`${group} > ${scenario}`] = samples
        work[`${group} > ${scenario}`] = Object.fromEntries([
          ...WORK.map((key) => [key, Math.round((last[key] - first[key]) / RUNS)]),
          ...SIZE.map((key) => [key, last[key]]),
        ])
      }
      const field = { type: 'Bus', field: 'init.Vr' }
      await measure('restyle', (i) =>
        bench.studio.bind(uri.toString(), field, i % 2 ? [] : ['vertexColor']),
      )
      await measure('camera move', async (i) => {
        await network.locator('canvas').hover()
        await bench.page.mouse.wheel(0, i % 2 ? 240 : -240)
      })
      await measure('labels', (i) =>
        settings.update('network.vertices.labels', i % 2 === 1, global),
      )
      await settings.update('network.vertices.labels', undefined, global)

      // Borders are drawn only on Earth, after the first frame.
      if (await network.getByRole('button', { name: 'Globe', exact: true }).isEnabled()) {
        await measure('borders', (i) => settings.update('network.borders', i % 2 === 1, global))
        const without = await settled()
        await settings.update('network.borders', undefined, global)
        await network.waitForFunction(
          '(segments) => gridkitStats().segments > segments',
          without.segments,
          { timeout: 60_000 },
        )
      }
    }
    const output = join(process.env.GRIDKIT_TEST_OUTPUT!, 'bench')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'head.json'), JSON.stringify({ timings, work, stages }, null, 2))
    console.log(`Benchmarks: ${Object.keys(timings).length} timed, written to ${output}`)
  } finally {
    for (const key of [...Object.keys(STILL), 'network.vertices.labels', 'network.borders'])
      await settings.update(key, undefined, global)
    await bench.browser.close()
  }
}
