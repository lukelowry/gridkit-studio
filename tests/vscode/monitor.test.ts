/** The Monitor: plotting in the bottom panel, the case's one clock played from the status bar,
 *  and its native menu. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

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
    await vscode.commands.executeCommand('gridkitStudio.goToTime', 0.5)
    assert.equal(transport().currentT(), 0.5)
    await until(
      async () => Math.abs((await bench.times())[0]! - 0.5) < 0.01,
      'the status bar reads the playhead',
    )
  })

  test('changes that clock from the status bar', async () => {
    await bench.playback('Play').click()
    await until(() => transport().state.status === 'playing', 'playback from the status bar')
    await vscode.commands.executeCommand('gridkitStudio.playPause')
    assert.equal(transport().state.status, 'paused')
    const paused = transport().currentT()
    await bench.playback('Next sample').click()
    await until(() => transport().currentT() > paused, 'a frame step from the status bar')
    const stepped = transport().currentT()
    await bench.playback('Previous sample').click()
    await until(() => transport().currentT() < stepped, 'a frame step back from the status bar')
    await bench.playback('Speed').click()
    await bench.pick('2')
    await until(() => transport().state.rate === 2, 'a faster speed')
    await until(async () => (await bench.playback('Speed').innerText()).includes('2'), 'it says so')
    await bench.palette('Go to End')
    await until(() => transport().currentT() === transport().state.span[1], 'the run ends')
  })

  test('goes to the time it is told, from the Command Palette', async () => {
    await bench.palette('Go to Time…')
    await bench.answer('0.25')
    await until(() => transport().currentT() === 0.25, 'the playhead at 0.25 s')
    assert.equal(transport().state.status, 'paused')
  })

  test('steps and plays from its keys while it has focus', async () => {
    transport().pause()
    transport().seek(0.5)
    const canvas = monitor.locator('canvas').first()
    await canvas.focus()
    const at = transport().currentT()
    await canvas.press('ArrowRight')
    await until(() => transport().currentT() > at, 'Right steps forward')
    await canvas.press('ArrowLeft')
    await until(() => transport().currentT() === at, 'Left steps back')
    await canvas.press(' ')
    await until(() => transport().state.status === 'playing', 'Space plays')
    await canvas.press(' ')
    await until(() => transport().state.status === 'paused', 'Space pauses')
    // Home fits the plot to the whole run, which every plot then shows.
    const whole = bench.session.results!.domain
    const middle = (whole[0] + whole[1]) / 2
    bench.session.setWindow([whole[0], middle])
    const shown = () =>
      monitor.evaluate<number[]>(`document.querySelector('canvas').gridkitPlot().camera.x`)
    await until(async () => (await shown())[1] === middle, 'half the run shown')
    await canvas.press('Home')
    await until(async () => {
      const [start, end] = await shown()
      const width = whole[1] - whole[0]
      return Math.abs(start - whole[0]) < width * 1e-6 && Math.abs(end - whole[1]) < width * 1e-6
    }, 'Home shows the whole run')
  })

  test('opens its settings from its title bar', async () => {
    await bench.title('monitor', 'Monitor Settings')
    await bench.settings(/gridkitStudio\.monitor/)
  })

  test('keeps its plots while another panel takes its place', async () => {
    const plots = structuredClone(bench.session.plots)
    await visible(await bench.show('case'), 'tbody .cell')
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.deepEqual(bench.session.plots, plots)
    assert.equal(await monitor.locator('.lane').count(), plots.length)
  })

  test("moves as VS Code's own motion setting says", async () => {
    const workbench = vscode.workspace.getConfiguration('workbench')
    const motion = () =>
      monitor.evaluate(`({
        duration: getComputedStyle(document.body).getPropertyValue('--motion-fast').trim(),
        renderer: document.querySelector('canvas').gridkitPlot().motion
      })`) as Promise<{ duration: string; renderer: string }>
    const set = (value: string | undefined) =>
      workbench.update('reduceMotion', value, vscode.ConfigurationTarget.Global)
    try {
      await set('on')
      await until(async () => (await motion()).renderer === 'reduced', 'motion reduced')
      assert.equal((await motion()).duration, '0ms')
      await set('off')
      await until(async () => (await motion()).renderer === 'system', 'full motion')
      assert.equal((await motion()).duration, '80ms')
    } finally {
      await set(undefined)
    }
  })

  test('selects a native trace by clicking its plotted value', async () => {
    const results = bench.session.results!
    const output = results.outputs.find((item) => item.table === 'Bus' && item.field === 'Vm')!
    const id = output.ids[0]!
    bench.session.setPlots([
      { from: 'Bus', field: 'Vm' },
      { from: 'Bus', field: 'Vm', id },
    ])
    bench.session.setWindow(undefined)
    bench.session.select()
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    const at = (results.domain[0] + results.domain[1]) / 2
    const exact = await bench.studio.client.results.call('sample', {
      results: results.id,
      table: 'Bus',
      field: 'Vm',
      id,
      at,
    })
    const canvas = monitor.locator('canvas').nth(1)
    await canvas.scrollIntoViewIfNeeded()
    await until(
      () =>
        monitor.evaluate<boolean>(
          'document.querySelectorAll("canvas")[1]?.gridkitPlot?.().complete',
        ),
      'second plot complete',
    )
    const point = await monitor.evaluate<[number, number]>(
      'document.querySelectorAll("canvas")[1].gridkitPoint(' + at + ',' + exact.value + ')',
    )
    await canvas.click({ position: { x: point[0], y: point[1] } })
    await until(
      () => bench.session.selection?.id === id,
      async () =>
        'native trace selected: ' +
        JSON.stringify({
          session: bench.session.selection,
          native: await monitor.evaluate('document.querySelectorAll("canvas")[1].gridkitPlot()'),
        }),
    )
  })

  test('keeps bounded native plot sources across repeated window changes', async () => {
    const results = await bench.waveform('Native windows.csv', 46_000, 46, 3)
    bench.session.setPlots([{ from: VM.table, field: VM.field }])
    monitor = await bench.show('monitor')
    for (const start of [0, 20, 40, 10, 0]) {
      bench.session.setWindow([start, Math.min(results.domain[1], start + 3)])
      await until(async () => {
        const state = await monitor.evaluate<{
          cacheBytes: number
          reads: number
          views: number
          plots: { camera: { x: number[] }; drawn: number }[]
        }>('gridkitMonitor()')
        assert.ok(state.cacheBytes <= 96 * 1024 * 1024)
        assert.ok(state.reads <= 2)
        return (
          state.reads === 0 &&
          state.views === 1 &&
          state.plots[0]!.drawn > 0 &&
          state.plots[0]!.camera.x[0] === start
        )
      }, 'a bounded native window is rendered')
    }
  })
})
