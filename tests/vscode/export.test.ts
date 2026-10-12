/** Video export: a run written to the file the user picks. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { simpleDialog, type TestHost, testHost, until, visible, VM } from './harness.js'

/** Start the export once it can, with Enter on its button: the view, squeezed under others in the
 *  side bar, scrolls, and a click at the button's place can miss it. */
async function startExport(exporter: Frame): Promise<void> {
  const button = exporter.locator('[data-testid="video-start"]')
  await until(() => button.isEnabled(), 'the export can start')
  await button.press('Enter')
}

/** The video at `path`: a WebM file, by the EBML header it starts with, holding more than that;
 *  its size. */
async function webm(path: string): Promise<number> {
  const bytes = await readFile(path)
  assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], 'a WebM file')
  assert.ok(bytes.length > 1000, 'The exported video has frames')
  return bytes.length
}

suite('Export', () => {
  let bench: TestHost

  suiteSetup(async () => {
    bench = await testHost()
    await bench.results()
    await simpleDialog(true)
  })
  suiteTeardown(() => simpleDialog(undefined))

  test('writes a video of the run to the file the user picks', async () => {
    const video = vscode.Uri.joinPath(bench.uri, '..', 'IEEE39 run.webm')
    const exporter = await bench.show('export')
    await visible(exporter, '[data-testid="video-export"]')
    await exporter.getByRole('switch', { name: 'Monitor' }).click()
    await exporter.locator('[data-testid="video-format"]').click()
    await exporter.locator('[role="option"][data-value="webm"]').click()
    await exporter.locator('[data-testid="video-resolution"]').click()
    await exporter.locator('[role="option"][data-value="720"]').click()
    await startExport(exporter)
    await bench.dialog(video.fsPath)
    await exporter.locator('[data-testid="video-done"]').waitFor({ timeout: 120_000 })
    bench.report.videoBytes = await webm(video.fsPath)
    await bench.capture('export-vscode')
  }).timeout(180_000)

  test('maps each moment it draws from the samples of that moment, chunk after chunk', async () => {
    // Results long enough for several chunks, with the Network mapping their voltage.
    const shown = await bench.results()
    const results = await bench.waveform('Long waveform.csv', 30_000, 3)
    const { chunk, frames, domain } = results
    assert.ok(frames > 2 * chunk, `the results span three chunks: ${frames} of ${chunk}`)
    const boundary = (k: number) => domain[0] + ((domain[1] - domain[0]) * k * chunk) / frames
    bench.session.bind(VM, ['vertexColor'])
    const video = vscode.Uri.joinPath(bench.uri, '..', 'IEEE39 chunks.webm')
    try {
      const exporter = await bench.show('export')
      await visible(exporter, '[data-testid="video-export"]')
      // The Network's part alone, over a time that crosses from the first chunk into the third.
      const plots = exporter.getByRole('switch', { name: 'Monitor' })
      if ((await plots.getAttribute('aria-checked')) === 'true') await plots.click()
      const start = boundary(1) - 0.05
      const end = boundary(2) + 0.05
      await exporter.getByLabel('Start (s)').fill(String(start))
      await exporter.getByLabel('End (s)').fill(String(end))
      await startExport(exporter)
      await bench.dialog(video.fsPath)
      await exporter.locator('[data-testid="video-done"]').waitFor({ timeout: 120_000 })
      await webm(video.fsPath)
      const { moments } = await exporter.evaluate<{ moments: number[] }>('gridkitExport()')
      // Each moment's samples were held when it drew, in order, from either side of both bounds.
      assert.ok(moments.length > 2, moments.join())
      assert.ok(
        moments.every((t, i) => i === 0 || t >= moments[i - 1]!),
        moments.join(),
      )
      assert.ok(moments[0]! < boundary(1) && moments.at(-1)! > boundary(2), moments.join())
    } finally {
      bench.session.bind(VM, [])
      await bench.session.load(shown.path)
    }
  }).timeout(180_000)

  test('plots a run holding more than a page keeps by streaming it through the plots first', async () => {
    const shown = await bench.results()
    // Every bus's voltage over more than the two chunks a first reply brings, and a budget a quarter
    // of that. The run is short, so the video records a few frames of it.
    const results = await bench.waveform('Streamed waveform.csv', 30_000, 0.3, 3)
    assert.ok(results.frames > 2 * results.chunk, 'The run must span more than two chunks')
    const budget = Math.floor((results.frames * (bench.source.buses.length + 1) * 8) / 4)
    bench.session.setPlots([{ from: VM.type, field: VM.field }])
    const video = vscode.Uri.joinPath(bench.uri, '..', 'IEEE39 streamed.webm')
    const exporter = await bench.show('export')
    try {
      await visible(exporter, '[data-testid="video-export"]')
      await exporter.evaluate((bytes) => {
        ;(globalThis as { gridkitPlotBudget?: number }).gridkitPlotBudget = bytes
      }, budget)
      // The Monitor's part alone, over the whole run.
      for (const [name, on] of [
        ['Network', false],
        ['Monitor', true],
      ] as const) {
        const toggle = exporter.getByRole('switch', { name, exact: true })
        if (((await toggle.getAttribute('aria-checked')) === 'true') !== on) await toggle.click()
      }
      await startExport(exporter)
      await bench.dialog(video.fsPath)
      await exporter.locator('[data-testid="video-done"]').waitFor({ timeout: 120_000 })
      await webm(video.fsPath)
      const { slices } = await exporter.evaluate<{ slices: number }>('gridkitExport()')
      assert.ok(slices > 1, `${slices} slices streamed through the plots`)
    } finally {
      await exporter.evaluate(() => {
        delete (globalThis as { gridkitPlotBudget?: number }).gridkitPlotBudget
      })
      await bench.session.load(shown.path)
    }
  }).timeout(180_000)
})
