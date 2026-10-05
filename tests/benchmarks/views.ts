/** Network view benchmarks inside VS Code: each scenario's time over RUNS, and its exact work per
 *  run, which gate.mjs holds to work.json. Each case also checks that its canvas fills the editor,
 *  and each geographic case that borders draw. */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { fills, idle, testHost } from '../vscode/harness.js'

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
      /** The next frame after `frames`, as soon as it draws. */
      const painted = (frames: number) =>
        network.waitForFunction('(frames) => gridkitStats().frames > frames', frames, {
          polling: 'raf',
          timeout: 60_000,
        })

      const firsts: number[] = []
      const shown: number[] = []
      for (let i = 0; i < RUNS; i++) {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        const start = performance.now()
        ;({ uri, network } = await bench.openCase(path))
        firsts.push(performance.now() - start)
        shown.push(
          await network.evaluate<number>(
            "performance.getEntriesByName('canvas:frame')[0].startTime - performance.getEntriesByName('canvas:boot')[0].startTime",
          ),
        )
      }
      // Until the view settles, and until the page's own first frame: what the user sees first.
      timings[group + ' > first frame'] = firsts
      timings[group + ' > first frame (page)'] = shown
      assert.ok(await fills(network), path + ': the canvas fills its editor')
      stages[group] = await network.evaluate(
        'Object.fromEntries(performance.getEntriesByType("mark").map((e) => [e.name, e.startTime]))',
      )

      async function measure(scenario: string, act: (i: number) => unknown) {
        const samples: number[] = []
        const first = await idle<Stats>(network)
        for (let i = 0; i < RUNS; i++) {
          const { frames } = await idle<Stats>(network)
          const start = performance.now()
          await act(i)
          await painted(frames)
          samples.push(performance.now() - start)
        }
        const last = await idle<Stats>(network)
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

      // Borders draw only on Earth, after the first frame.
      if (await network.getByRole('button', { name: 'Globe', exact: true }).isEnabled()) {
        await measure('borders', (i) => settings.update('network.borders', i % 2 === 1, global))
        const without = await idle<Stats>(network)
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
