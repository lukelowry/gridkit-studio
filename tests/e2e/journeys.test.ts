/** What a user does with a case, end to end in a real window on a real GPU: every view draws it, a
 *  run is plotted, and pictures and videos are written. Everything
 *  under these journeys is the unit, contract and extension-host suites' to check; these check that
 *  the pieces meet where a user sees them. */

import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import { idle, simpleDialog, type TestHost, testHost, until, visible, VM } from './harness.js'

/** A PNG at `path` once written, which draws more than its background. */
async function png(path: string): Promise<PNG> {
  const image = await until(async () => {
    try {
      return PNG.sync.read(await readFile(path))
    } catch {
      return undefined
    }
  }, 'the image written')
  const colors = new Set<number>()
  for (let at = 0; at < image.data.length; at += 4) colors.add(image.data.readUInt32BE(at))
  assert.ok(colors.size > 1, 'the image draws more than its background')
  return image
}

suite('Journeys', function () {
  this.timeout(180_000)
  let bench: TestHost

  suiteSetup(async () => {
    bench = await testHost()
    await simpleDialog(true)
  })
  suiteTeardown(() => simpleDialog(undefined))

  test('every view draws the case, and a bus picked in the Network is picked in all', async () => {
    const network = await bench.open()
    const table = await bench.show('case')
    await visible(table, 'tbody .cell')
    // The bus nearest the middle of the whole case, framed, clear of the toolbar at the edge.
    await vscode.commands.executeCommand('gridkitStudio.fit', bench.uri)
    await idle(network)
    const box = (await network.locator('canvas').boundingBox())!
    const ids = bench.source.buses.map(({ number }) => number)
    const points = await network.evaluate<([number, number] | null)[]>(
      `Promise.all(${JSON.stringify(ids)}.map(id => gridkitLocate({ table: 'Bus', id })))`,
    )
    const away = (point: [number, number] | null) =>
      point ? Math.hypot(point[0] - box.width / 2, point[1] - box.height / 2) : Infinity
    const nearest = points.reduce(
      (best, point, i) => (away(point) < away(points[best]!) ? i : best),
      0,
    )
    const bus = ids[nearest]!
    const [x, y] = points[nearest]!
    await bench.page.mouse.click(box.x + x, box.y + y)
    await until(() => bench.session.selection?.id === bus, 'the bus picked')
    await visible(table, 'tbody tr.selected')
    await bench.capture('journey-views')
  })

  test('a run of the solver file is followed live, then played', async function () {
    if (!(await bench.gridkit())) this.skip()
    await bench.record(VM.table, [VM.field])
    await bench.writeSolver({ tmax: 2, dt_monitor: 0.001, events: [] })
    bench.explorer('Run Dynamic Simulation')
    const monitor = await bench.view('monitor')
    await until(() => bench.session.run?.state === 'complete', 'the run ends', 120_000)
    await visible(monitor, 'canvas[data-rendered=true]')
    const end = bench.session.results!.domain[1]
    await until(
      async () =>
        (
          await monitor.evaluate<number[] | undefined>(
            'document.querySelector("canvas").gridkitPlot().span',
          )
        )?.[1] === end,
      'the plot holds the whole run',
    )
    await bench.playback('Previous sample').click()
    await until(() => bench.session.transport.currentT() < end, 'the status bar steps back')
    await bench.capture('journey-run')
  })

  test('the Network is saved as a picture, and the Monitor as a video', async () => {
    const network = await bench.open()
    // What the Network shows at rest is what a video of it frames: its camera, over its canvas.
    await idle(network)
    const framing = await network.evaluate<unknown>(
      `({ camera: gridkitSelection().camera, size: [document.querySelector('canvas').clientWidth, document.querySelector('canvas').clientHeight] })`,
    )
    await until(
      () => JSON.stringify(bench.session.framing) === JSON.stringify(framing),
      'the framing a video keeps',
    )
    const image = vscode.Uri.joinPath(bench.uri, '..', 'IEEE39 network.png')
    await rm(image.fsPath, { force: true })
    await bench.title('editor', 'Export Image')
    await bench.dialog(image.fsPath)
    const { width } = await png(image.fsPath)
    const shown = await network.evaluate<number>(
      'document.querySelector("canvas").getBoundingClientRect().width',
    )
    assert.ok(Math.abs(width - 2 * shown) <= 2, `${width} wide for ${shown}`)

    await bench.results()
    const video = vscode.Uri.joinPath(bench.uri, '..', 'IEEE39 run.mp4')
    await rm(video.fsPath, { force: true })
    const exporter = await bench.show('export')
    await visible(exporter, '[data-testid="video-export"]')
    for (const [name, on] of [
      ['Network', false],
      ['Monitor', true],
    ] as const) {
      const toggle = exporter.getByRole('switch', { name, exact: true })
      if (((await toggle.getAttribute('aria-checked')) === 'true') !== on) await toggle.click()
    }
    await exporter.locator('[data-testid="video-resolution"]').click()
    await exporter.locator('[role="option"][data-value="720"]').click()
    const start = exporter.locator('[data-testid="video-start"]')
    await until(() => start.isEnabled(), 'the export can start')
    await start.press('Enter')
    await bench.dialog(video.fsPath)
    await until(
      async () =>
        (await exporter.evaluate<{ status: string }>('gridkitExport()')).status === 'done',
      'the video written',
    )
    const bytes = await readFile(video.fsPath)
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp', 'an MP4')
  })
})
