/** The Network editor: drawing, its own controls, selection, a kept webview, and the shared clock. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import {
  fills,
  frames,
  idle,
  stats,
  type TestHost,
  testHost,
  until,
  visible,
  VM,
} from './harness.js'

/** Markers large enough that their center pixels are solid, at one size whatever the zoom, with
 *  nothing drawn over them. */
const SOLID: Record<string, unknown> = {
  'network.vertexRadiusPx': 8,
  'network.vertexMinRadiusPx': 8,
  'network.vertices.labels': false,
  'network.map.source': 'none',
  'network.hover': 'off',
  'network.selectedColor': '#00000000',
}
type RGB = readonly [number, number, number]
/** Whether two colors differ by more than antialiasing does. */
const apart = (a: RGB, b: RGB) => a.some((channel, i) => Math.abs(channel - b[i]!) > 24)

suite('Network', () => {
  let bench: TestHost
  let network: Frame

  suiteSetup(async () => {
    bench = await testHost()
    network = await bench.open('network')
  })

  test('draws the case, filling its editor', async () => {
    assert.equal(bench.studio.state(bench.key).summary?.counts.Bus, bench.source.buses.length)
    assert.equal(await network.locator('.status').count(), 0)
    assert.ok(await fills(network), 'Network must fill its editor')
    bench.report.network = await stats(network)
    await bench.capture('network-vscode')
  })

  test('carries its projections and rotation, and Fit in the editor title bar', async () => {
    await visible(network, '[data-testid="view-toolbar"]')
    for (const name of ['Flat', 'Tilt', 'Globe', 'Auto-rotate'])
      assert.equal(await network.getByRole('button', { name, exact: true }).count(), 1, name)
    await bench.page
      .locator('.part.editor')
      .getByRole('button', { name: /^Fit All/ })
      .waitFor()
    await until(
      async () => (await network.locator('.toolbar button[aria-pressed="true"]').count()) === 1,
      'the projection on show is pressed',
    )
  })

  test('shrinks its markers as the view zooms out, so neighbors stay apart, and grows them back', async () => {
    /** How much markers shrink at the drawn zoom: 1 while they have room for their radius. */
    const fit = () => network.evaluate<number>('gridkitStats().markerFit')
    const wheel = async (deltaY: number) => {
      await network.locator('canvas').hover()
      await bench.page.mouse.wheel(0, deltaY)
      await idle(network)
      return fit()
    }
    try {
      await until(async () => (await wheel(-240)) === 1, 'markers at their own size, zoomed in')
      await until(async () => (await wheel(240)) < 1, 'markers shrink as the view zooms out')
      const out = await fit()
      assert.ok(out > 0, 'a shrunken marker still draws')
      await until(async () => (await wheel(-240)) === 1, 'markers grow back as the view zooms in')
    } finally {
      await vscode.commands.executeCommand('gridkitStudio.fit')
    }
  })

  test('clearing the canvas selection clears the shared selection', async () => {
    const drawn = await frames(network)
    bench.studio.select(bench.key, { id: 'Bus/' + bench.source.buses[0]!.number })
    await until(async () => (await frames(network)) > drawn, 'the selected bus is drawn')
    await network.locator('canvas').focus()
    await network.locator('canvas').press('Escape')
    await until(() => bench.session.selection === undefined, 'selection cleared across the case')
    assert.equal(bench.studio.state(bench.key).selection, undefined)
  })

  test('keeps its webview while another editor hides it', async () => {
    // A mark that tells the same view shown again from one built again.
    await network.evaluate('window.gridkitKept = true')
    await bench.open('diagram')
    network = await bench.open('network')
    assert.equal(await network.evaluate('window.gridkitKept'), true)
  })

  test('paints a mapped signal at the playhead every view shares', async () => {
    await bench.results()
    const { transport } = bench.session
    bench.studio.bind(bench.key, VM, ['vertexColor'])
    transport.setLoop('wrap')
    transport.seek(0)
    const still = await frames(network)
    transport.play()
    // Frame after frame while the clock plays, with no message from the extension.
    await until(async () => (await frames(network)) > still + 10, 'the network paints the playhead')
    transport.pause()
    await bench.capture('network-mapped-signal')
  })

  test('draws nothing while hidden, though the clock plays on', async () => {
    const { transport } = bench.session
    await bench.open('diagram')
    const hidden = (await idle(network)).frames
    const from = transport.currentT()
    transport.play()
    // Time enough for the visible view to have drawn many frames.
    await until(() => transport.currentT() > from + 0.2, 'the clock plays on')
    assert.equal(transport.state.status, 'playing')
    assert.equal(await frames(network), hidden)
    transport.pause()
  })

  test('colors a laid-out case by each mapping it is given, and by none once it is taken away', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    const global = vscode.ConfigurationTarget.Global
    for (const [key, value] of Object.entries(SOLID)) await settings.update(key, value, global)
    try {
      // The case alone, nothing mapped and its clock at rest, as the others left it otherwise.
      await bench.reset()
      network = await bench.open('network')
      const ids = bench.source.buses.slice(0, 8).map((bus) => 'Bus/' + bus.number)
      /** The color each bus's marker is drawn in at its center. */
      const colors = async (): Promise<RGB[]> => {
        await idle(network)
        const png = PNG.sync.read(await network.locator('canvas').screenshot())
        const points = await network.evaluate(
          (ids) =>
            ids.map((id) =>
              (
                globalThis as unknown as { gridkitLocate(id: string): [number, number] | null }
              ).gridkitLocate(id),
            ),
          ids,
        )
        return points.map((point) => {
          assert.ok(point, 'every bus is drawn')
          const at = (Math.round(point[1]) * png.width + Math.round(point[0])) * 4
          return [png.data[at]!, png.data[at + 1]!, png.data[at + 2]!] as const
        })
      }
      const redraw = async (change: () => unknown) => {
        const drawn = await frames(network)
        await change()
        await until(async () => (await frames(network)) > drawn, 'drawn again')
        return colors()
      }
      const plain = await colors()
      const given = { type: 'Bus', field: 'init.Vr' }
      const mapped = await redraw(() => bench.studio.bind(bench.key, given, ['vertexColor']))
      assert.ok(
        mapped.some((color, i) => apart(color, plain[i]!)),
        'a field mapped colors the buses',
      )
      const unmapped = await redraw(() => bench.studio.bind(bench.key, given, []))
      assert.ok(
        unmapped.every((color, i) => !apart(color, plain[i]!)),
        'a mapping taken away colors them as before',
      )
      // The same once the case is edited, and so laid out again, while the field is mapped.
      await redraw(() => bench.studio.bind(bench.key, given, ['vertexColor']))
      await bench.record('Bus', ['Vm'])
      const after = await redraw(() => bench.studio.bind(bench.key, given, []))
      assert.ok(
        after.every((color, i) => !apart(color, plain[i]!)),
        'a mapping taken away after a relayout colors them as before',
      )
    } finally {
      for (const key of Object.keys(SOLID)) await settings.update(key, undefined, global)
    }
  })

  test('lays out a case without coordinates, and offers the globe once its buses have them', async () => {
    network = await bench.open('network')
    const globe = () => network.getByRole('button', { name: 'Globe', exact: true })
    await until(() => globe().isDisabled(), 'no globe without coordinates')
    const source = JSON.parse(bench.text)
    source.buses.forEach((bus: { extension?: unknown }, i: number) => {
      bus.extension = { longitude: -100 + (i % 8) * 2, latitude: 30 + Math.floor(i / 8) * 2 }
    })
    await bench.replace(JSON.stringify(source))
    await bench.settled()
    network = await bench.open('network')
    await until(() => globe().isEnabled(), 'the globe offered')
    await globe().click()
    await until(
      async () =>
        (await network.evaluate<{ camera: { projection?: string } } | null>('gridkitSelection()'))
          ?.camera.projection === 'globe',
      'the network on the globe',
    )
    await bench.capture('network-globe')
  })

  test("lays Natural Earth's borders beneath a case on Earth, once it is on screen", async () => {
    await until(
      async () => (await network.evaluate<number>('gridkitStats().map?.vertices ?? 0')) > 0,
      'the borders drawn',
      60_000,
    )
    await bench.capture('network-borders')
  })
})
