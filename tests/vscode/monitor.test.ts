/** The Monitor: plotting in the bottom panel, the case's one clock played from the status bar,
 *  and its native menu. */

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Data } from '@latkit/model'
import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import type { SamplesInput } from '../../src/shared/messages.js'
import { type TestHost, testHost, until, visible, VM } from './harness.js'

suite('Monitor', () => {
  let bench: TestHost
  let monitor: Frame
  const transport = () => bench.session.transport

  suiteSetup(async () => {
    bench = await testHost()
    await bench.results()
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('plots the chosen signal in the bottom panel, played from the status bar', async () => {
    await bench.playback('Play').waitFor()
    await bench.page
      .locator('.part.panel')
      .getByRole('button', { name: /^Add Plot/ })
      .waitFor()
    assert.ok((await monitor.locator('.lane__name').first().textContent())?.includes('Bus'))
    const panel = await bench.page.locator('.part.panel').boundingBox()
    const plot = await monitor.locator('canvas').boundingBox()
    assert.ok(panel && plot && plot.y >= panel.y, 'Monitor must be in the bottom panel')
    await bench.capture('monitor-vscode')
  })

  test("follows the case's one clock when a command moves it", async () => {
    assert.equal(transport().state.status, 'paused')
    await vscode.commands.executeCommand('gridkitStudio.seekTime', 0.5)
    assert.equal(transport().currentT(), 0.5)
    await until(
      async () => Math.abs((await bench.times())[0]! - 0.5) < 0.01,
      'the status bar reads the playhead',
    )
  })

  test('changes that clock from the status bar', async () => {
    await bench.playback('Play').click()
    await until(() => transport().state.status === 'playing', 'playback from the status bar')
    await vscode.commands.executeCommand('gridkitStudio.toggleTimeline')
    assert.equal(transport().state.status, 'paused')
    const paused = transport().currentT()
    await bench.playback('Next sample').click()
    await until(() => transport().currentT() > paused, 'a frame step from the status bar')
    await bench.playback('Speed').click()
    await bench.pick('2')
    await until(() => transport().state.rate === 2, 'a faster speed')
    await until(async () => (await bench.playback('Speed').innerText()).includes('2'), 'it says so')
    await bench.playback('Go to end').click()
    await until(() => transport().currentT() === transport().state.span[1], 'the run ends')
  })

  test('opens its settings from its menu', async () => {
    await bench.menu(monitor.locator('canvas'), 'Monitor Settings')
    await bench.settings(/gridkitStudio\.monitor/)
  })

  test('keeps its plots while another panel takes its place', async () => {
    await visible(await bench.show('case'), 'tbody .cell')
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('preserves legacy Full motion and lets an explicit current preference override it', async () => {
    const path = join(process.env.GRIDKIT_TEST_PROFILE!, 'User', 'settings.json')
    const original = await readFile(path, 'utf8')
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    try {
      await writeFile(
        path,
        JSON.stringify({ ...JSON.parse(original), 'studio.display.motion': 'full' }),
      )
      await until(
        () => bench.session.settings['accessibility.motion'] === 'full',
        'legacy Full is respected',
      )
      await bench.page.emulateMedia({ reducedMotion: 'reduce' })
      const motion = () =>
        monitor.evaluate(`({
        preference: document.body.dataset.motion,
        duration: getComputedStyle(document.body).getPropertyValue('--motion-fast').trim(),
        renderer: document.querySelector('canvas').gridkitPlot().motion
      })`) as Promise<{ preference: string; duration: string; renderer: string }>
      await until(async () => (await motion()).renderer === 'full', 'renderer uses Full')
      assert.equal((await motion()).duration, '80ms', 'Full overrides reduced-motion media')
      await settings.update('accessibility.motion', 'reduce', vscode.ConfigurationTarget.Global)
      await until(
        async () => (await motion()).renderer === 'reduce',
        'explicit Reduce overrides legacy Full',
      )
      assert.equal((await motion()).duration, '0ms')
      await settings.update('accessibility.motion', 'system', vscode.ConfigurationTarget.Global)
      await until(async () => (await motion()).renderer === 'auto', 'System follows the device')
      assert.equal((await motion()).duration, '0ms')
      await settings.update('accessibility.motion', 'full', vscode.ConfigurationTarget.Global)
      await until(async () => (await motion()).renderer === 'full', 'explicit Full restored')
      assert.equal((await motion()).duration, '80ms')
    } finally {
      await bench.page.emulateMedia({ reducedMotion: null })
      await writeFile(path, original)
    }
  })

  test('draws the samples it holds around those it has not read, then those once they come', async () => {
    // The worker's replies of samples come without the frames `lacking` names, as if it had not
    // got to them, and an ask that brings nothing is not made again until the Monitor retries. It
    // names every frame until the run's chunks are known.
    const thread = bench.studio.client.results
    const call = thread.call
    let lacking: readonly [number, number] = [0, Infinity]
    /** The first frame of each batch of every bus's voltage the Monitor was sent. */
    const held: number[] = []
    thread.call = (async (method: string, input: unknown, signal?: AbortSignal) => {
      const value = await call.call(thread, method as never, input as never, signal)
      if (method !== 'samples') return value
      const kept = (value as Data.SampleBatch[]).filter(
        ({ firstFrame, coordinates }) =>
          firstFrame + coordinates.length <= lacking[0] || firstFrame >= lacking[1],
      )
      if (!(input as SamplesInput).field.rows) held.push(...kept.map((batch) => batch.firstFrame))
      return kept
    }) as typeof call
    try {
      monitor = await bench.show('monitor')
      // Every bus's voltage over three and a half chunks, so the start, the middle and the end of
      // the run come in replies of their own.
      const { chunk, frames, domain } = await bench.waveform('Long waveform.csv', 46_000, 46, 3)
      assert.ok(frames >= 3 * chunk, 'The run must span more than three chunks')
      bench.session.plots = [{ from: VM.type, field: VM.field }]
      bench.studio.changed.fire(bench.key)
      lacking = [chunk, 3 * chunk]
      const show = (window: [number, number] | undefined) => {
        bench.session.window = window
        bench.studio.changed.fire(bench.key)
      }
      /** The frames of the readings under the plot at `at`, a voltage of 1. */
      const readings = (at: number) =>
        monitor.evaluate<number[] | null>(`(async () => {
          const canvas = document.querySelector('canvas')
          const point = canvas?.gridkitPoint?.(${at}, 1)
          if (!point || !canvas.gridkitRead) return null
          return (await canvas.gridkitRead([point[0], point[1]])).map(({ frame }) => frame)
        })()`)
      const step = (domain[1] - domain[0]) / 100
      show([domain[1] - step, domain[1]])
      await until(() => held.some((frame) => frame >= 3 * chunk), 'the Monitor holds the end')
      show([domain[0], domain[0] + step])
      await until(() => held.some((frame) => frame < chunk), 'the Monitor holds the start')
      // The whole run, its start and end held and its middle not: the plot draws each run it holds
      // and nothing between them.
      show(undefined)
      const middle = (domain[0] + domain[1]) / 2
      await until(async () => {
        const [start, end] = await Promise.all([readings(step), readings(domain[1] - step)])
        return start?.length && end?.length
      }, 'the Monitor draws the start and end of the run')
      const lacked = await readings(middle)
      assert.ok(lacked, 'The plot reads its middle')
      assert.ok(
        lacked.every((frame) => frame < chunk || frame >= 3 * chunk),
        'The plot draws nothing where it holds nothing',
      )
      // The middle comes once asked for again.
      lacking = [0, 0]
      await vscode.commands.executeCommand('gridkitStudio.retryMonitor', bench.uri)
      await until(
        async () => (await readings(middle))?.some((frame) => frame >= chunk && frame < 3 * chunk),
        'the Monitor draws the middle of the run once it comes',
      )
    } finally {
      thread.call = call
      await bench.reset()
    }
  })

  test('streams a window holding more than its budget a slice at a time, drawing every frame of it', async () => {
    monitor = await bench.show('monitor')
    // Every bus's voltage over three and a half chunks, and a budget a third of that.
    const frames = 46_000
    const frameBytes = (bench.source.buses.length + 1) * 8
    const budget = Math.floor((frames * frameBytes) / 3)
    await monitor.evaluate((bytes) => {
      ;(globalThis as { gridkitPlotBudget?: number }).gridkitPlotBudget = bytes
    }, budget)
    try {
      const results = await bench.waveform('Streamed waveform.csv', frames, 4.6, 3)
      assert.ok(results.frames > 2 * results.chunk, 'The run must span more than two chunks')
      bench.session.plots = [{ from: VM.type, field: VM.field }]
      bench.studio.changed.fire(bench.key)
      // A plot drawn anew, so what it draws is counted from now.
      await vscode.commands.executeCommand('gridkitStudio.retryMonitor', bench.uri)
      type Drawn = { rows: number; segments: number; refining: boolean; wants: unknown }
      const drawn = () =>
        monitor.evaluate<Drawn | null>(`document.querySelector('canvas')?.gridkitPlot?.() ?? null`)
      type Held = { streaming: boolean; slice: unknown; bytes: number }
      let most = 0
      let seen: { held: Held; plot: Drawn | null } | undefined
      await until(
        async () => {
          const held = await monitor.evaluate<Held>('gridkitMonitor()')
          most = Math.max(most, held.bytes)
          const plot = await drawn()
          seen = { held, plot }
          // Streamed to the window's end, with nothing more to read, and drawn.
          return held.streaming && held.slice === null && plot !== null && !plot.refining
        },
        'the plot drawn to the end of its window',
        150_000,
      ).catch((error: Error) => {
        throw new Error(`${error.message}; last seen ${JSON.stringify(seen)}`)
      })
      const plot = (await drawn())!
      bench.report.streamed = { ...plot, frames: results.frames, most, budget }
      // Every trace joined frame to frame across the whole window.
      assert.ok(
        plot.segments >= plot.rows * (results.frames - 1),
        `${plot.segments} segments drawn for ${plot.rows} traces of ${results.frames} frames`,
      )
      // About a budget held, a slice past it at most, and far less than the window.
      assert.ok(most <= budget + 2 * results.chunk * frameBytes, `${most} bytes held of ${budget}`)
      assert.ok(most < results.frames * frameBytes, `${most} bytes held, the window's every one`)
    } finally {
      await monitor.evaluate(() => {
        delete (globalThis as { gridkitPlotBudget?: number }).gridkitPlotBudget
      })
      await bench.reset()
    }
  }).timeout(180_000)
})
