/** Video export: a run written to the file the user picks. */

import assert from 'node:assert/strict'
import { open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { formatNumber } from '../../src/shared/format.js'
import { notified, simpleDialog, type TestHost, testHost, until, visible, VM } from './harness.js'

/** Start the export once it can, with Enter on its button: the view, squeezed under others in the
 *  side bar, scrolls, and a click at the button's place can miss it. */
async function exported(exporter: Frame, timeout = 120_000): Promise<void> {
  await until(
    async () => {
      const { status, progress } = await exporter.evaluate<{ status: string; progress: unknown }>(
        'gridkitExport()',
      )
      if (status === 'idle' && progress === null)
        throw new Error('Export failed before producing its first frame.')
      if (status === 'idle' && progress)
        throw new Error('Export failed: ' + JSON.stringify(progress))
      return status === 'done'
    },
    'the MP4 export finishes',
    timeout,
  )
}
async function startExport(exporter: Frame): Promise<void> {
  const button = exporter.locator('[data-testid="video-start"]')
  await until(() => button.isEnabled(), 'the export can start')
  await button.press('Enter')
}

/** Validate the MP4 container emitted by native H.264 encoding. */
async function mp4(path: string): Promise<number> {
  const bytes = await readFile(path)
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp')
  const boxes: string[] = []
  for (let offset = 0; offset + 8 <= bytes.length;) {
    boxes.push(bytes.toString('ascii', offset + 4, offset + 8))
    const short = bytes.readUInt32BE(offset)
    const size =
      short === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : short || bytes.length - offset
    assert.ok(size >= 8 && offset + size <= bytes.length, 'Complete MP4 box')
    offset += size
  }
  assert.ok(boxes.includes('moov') && boxes.includes('mdat'), boxes.join())
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
    const video = vscode.Uri.joinPath(bench.uri, '..', 'IEEE39 run.mp4')
    const exporter = await bench.show('export')
    await visible(exporter, '[data-testid="video-export"]')
    await exporter.getByRole('switch', { name: 'Monitor' }).click()
    assert.equal(await exporter.locator('[data-testid="video-format"]').count(), 0)
    await exporter.locator('[data-testid="video-resolution"]').click()
    await exporter.locator('[role="option"][data-value="720"]').click()
    await startExport(exporter)
    await bench.dialog(video.fsPath)
    await exported(exporter)
    bench.report.videoBytes = await mp4(video.fsPath)
    await bench.capture('export-vscode')
  }).timeout(180_000)

  test('maps each moment of the times the Monitor shows from the samples of that moment, chunk after chunk', async () => {
    // Results long enough for several chunks, with the Network mapping their voltage.
    const shown = await bench.results()
    const results = await bench.waveform('Long waveform.csv', 30_000, 3)
    const { chunk, frames, domain } = results
    assert.ok(frames > 2 * chunk, `the results span three chunks: ${frames} of ${chunk}`)
    const boundary = (k: number) => domain[0] + ((domain[1] - domain[0]) * k * chunk) / frames
    bench.session.bind(VM, ['vertexColor'])
    const video = vscode.Uri.joinPath(bench.uri, '..', 'IEEE39 chunks.mp4')
    try {
      const exporter = await bench.show('export')
      await visible(exporter, '[data-testid="video-export"]')
      // The Network's part alone, over the time the Monitor shows: from the first chunk into the
      // third, at twice the speed.
      const plots = exporter.getByRole('switch', { name: 'Monitor' })
      if ((await plots.getAttribute('aria-checked')) === 'true') await plots.click()
      const start = boundary(1) - 0.05
      const end = boundary(2) + 0.05
      bench.session.setWindow([start, end])
      bench.session.transport.setRate(2)
      const time = exporter.locator('[data-testid="video-time"]')
      const said = `${formatNumber(start)} to ${formatNumber(end)} s`
      await until(async () => {
        const text = await time.innerText().catch(() => '')
        return text.includes(said) && text.includes('2× playback speed')
      }, 'the video says it shows the times the Monitor shows, at its speed')
      await startExport(exporter)
      await bench.dialog(video.fsPath)
      await exported(exporter)
      await mp4(video.fsPath)
      const { progress } = await exporter.evaluate<{
        progress: { frames: number; total: number; time: number }
      }>('gridkitExport()')
      assert.equal(progress.frames, progress.total)
      assert.ok(progress.total > 2 && progress.time > boundary(2) && progress.time <= end)
    } finally {
      bench.session.bind(VM, [])
      bench.session.transport.setRate(1)
      await bench.session.load(shown.path)
    }
  }).timeout(180_000)

  test('plots a long run through bounded native visualization levels', async () => {
    const shown = await bench.results()
    // Every bus's voltage over more than the two chunks a first reply brings, and a budget a quarter
    // of that. The run is short, so the video records a few frames of it.
    const results = await bench.waveform('Streamed waveform.csv', 30_000, 0.3, 3)
    assert.ok(results.frames > 2 * results.chunk, 'The run must span more than two chunks')
    // The Case panel takes the Monitor's place, which would draw the same plots beside the export:
    // on a software GPU that holds up every frame the window draws, for tens of seconds.
    await bench.show('case')
    bench.session.setPlots([{ from: VM.table, field: VM.field }])
    const video = vscode.Uri.joinPath(bench.uri, '..', 'IEEE39 streamed.mp4')
    const exporter = await bench.show('export')
    try {
      await visible(exporter, '[data-testid="video-export"]')
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
      // Drawing every slice through the plots first takes about two minutes on a software GPU.
      await exported(exporter, 240_000)
      await mp4(video.fsPath)
      const { progress } = await exporter.evaluate<{ progress: { frames: number; total: number } }>(
        'gridkitExport()',
      )
      assert.ok(progress.frames > 1 && progress.frames === progress.total)
    } finally {
      await bench.session.load(shown.path)
    }
  }).timeout(300_000)

  for (const failure of ['cancel', 'write failure'] as const) {
    test(`preserves the destination and releases native encoding on ${failure}`, async () => {
      await bench.results()
      const exporter = await bench.show('export')
      const destination = vscode.Uri.joinPath(bench.uri, '..', `native-${failure}.mp4`)
      await rm(destination.fsPath, { force: true })
      const probe = await open(destination.fsPath + '.probe', 'w')
      const prototype = Object.getPrototypeOf(probe) as typeof probe
      const write = prototype.write
      await probe.close()
      await rm(destination.fsPath + '.probe')
      let reached = false
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      prototype.write = async function (this: typeof probe, ...args: unknown[]) {
        const bytes = args[0]
        if (
          !reached &&
          bytes instanceof Uint8Array &&
          Buffer.from(bytes.subarray(4, 8)).toString() === 'ftyp'
        ) {
          reached = true
          await held
          if (failure === 'write failure') throw new Error('Injected MP4 write failure')
        }
        return Reflect.apply(write, this, args)
      } as typeof write
      try {
        await startExport(exporter)
        await bench.dialog(destination.fsPath)
        await until(() => reached, 'the native encoder waits for output backpressure')
        await writeFile(destination.fsPath, 'original destination')
        if (failure === 'cancel')
          await exporter.getByRole('button', { name: 'Cancel', exact: true }).click()
        release()
        await until(async () => {
          const state = await exporter.evaluate<{ status: string }>('gridkitExport()')
          return state.status === (failure === 'cancel' ? 'cancelled' : 'idle')
        }, 'the export ends and cleans up')
        assert.equal(await readFile(destination.fsPath, 'utf8'), 'original destination')
        assert.ok(
          !(await readdir(dirname(destination.fsPath))).some(
            (name) => name.startsWith(basename(destination.fsPath) + '.') && name.endsWith('.tmp'),
          ),
        )
        if (failure === 'write failure') {
          await until(() => bench.studio.reporter.errors.length > 0, 'the failed write is reported')
          assert.ok(
            (await notified('the output failure')).every((message) =>
              message.includes('Injected MP4 write failure'),
            ),
          )
          assert.ok(
            bench.studio.reporter.errors
              .splice(0)
              .every((error) => error.includes('Injected MP4 write failure')),
          )
        }
      } finally {
        release()
        prototype.write = write
      }
    })
  }
})
