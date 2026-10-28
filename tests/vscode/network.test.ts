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
  pause,
  replaying,
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
  'network.labels': false,
  'network.map.source': 'none',
  'network.ease': 0,
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

  test('changes the native camera without reloading the dataset', async () => {
    const before = await network.evaluate<{ camera: unknown }>('gridkitSelection()')
    const received = await network.evaluate<number>('gridkitStats().received')
    await network.locator('canvas').hover()
    await bench.page.mouse.wheel(0, -240)
    await until(
      async () =>
        JSON.stringify(
          (await network.evaluate<{ camera: unknown }>('gridkitSelection()')).camera,
        ) !== JSON.stringify(before.camera),
      'the camera zooms',
    )
    assert.equal(await network.evaluate('gridkitStats().received'), received)
    await vscode.commands.executeCommand('gridkitStudio.fit')
  })

  test('clearing the canvas selection clears the shared selection', async () => {
    const drawn = await frames(network)
    bench.session.select({ table: 'Bus', id: bench.source.buses[0]!.number })
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
    bench.session.bind(VM, ['vertexColor'])
    transport.seek(0)
    const still = await frames(network)
    // Frame after frame while the clock plays, with no message from the extension. A second of
    // results plays once, which a slow GPU draws in fewer frames than this asks for, so it plays
    // again each time it ends.
    const replay = replaying(bench.studio, bench.session)
    try {
      transport.play()
      await until(
        async () => (await frames(network)) > still + 10,
        'the network paints the playhead',
      )
    } finally {
      replay.dispose()
      transport.pause()
    }
    await bench.capture('network-mapped-signal')
  })

  test('draws nothing while hidden, though the clock plays on', async () => {
    const { transport } = bench.session
    await bench.open('diagram')
    await until(
      () => network.evaluate('gridkitStats() === undefined'),
      'the hidden View is destroyed',
    )
    // From the start, so the clock has the run before it to play on rather than wrap.
    transport.seek(0)
    const from = transport.currentT()
    transport.play()
    // Time enough for the visible view to have drawn many frames.
    await until(() => transport.currentT() > from + 0.2, 'the clock plays on')
    assert.equal(transport.state.status, 'playing')
    assert.equal(await network.evaluate('gridkitStats()'), undefined)
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
      await vscode.commands.executeCommand('gridkitStudio.fit', bench.uri)
      const ids = bench.source.buses.slice(0, 8).map((bus) => ({ table: 'Bus', id: bus.number }))
      /** The color each bus's marker is drawn in at its center. */
      const colors = async (): Promise<RGB[]> => {
        await idle(network)
        const png = PNG.sync.read(await network.locator('canvas').screenshot())
        const points = await network.evaluate(
          (ids) =>
            Promise.all(
              ids.map((id) =>
                (
                  globalThis as unknown as {
                    gridkitLocate(id: {
                      table: string
                      id: number
                    }): Promise<[number, number] | null>
                  }
                ).gridkitLocate(id),
              ),
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
        await until(
          async () =>
            JSON.stringify(await network.evaluate('gridkitStats().bindings')) ===
            JSON.stringify(bench.session.bindings),
          'the complete mapping projection is displayed',
        )
        await until(async () => (await frames(network)) > drawn, 'drawn again')
        return colors()
      }
      const plain = await colors()
      const given = { table: 'Bus', field: 'init.Vr' }
      const mapped = await redraw(() => bench.session.bind(given, ['vertexColor']))
      assert.ok(
        mapped.some((color, i) => apart(color, plain[i]!)),
        'a field mapped colors the buses',
      )
      const unmapped = await redraw(() => bench.session.bind(given, []))
      assert.ok(
        unmapped.every((color, i) => !apart(color, plain[i]!)),
        'a mapping taken away colors them as before',
      )
      // The same once the case is edited, and so laid out again, while the field is mapped.
      await redraw(() => bench.session.bind(given, ['vertexColor']))
      await bench.record('Bus', ['Vm'])
      const after = await redraw(() => bench.session.bind(given, []))
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
        await network.evaluate<boolean>("gridkitStats().space.earth.projection === 'globe'"),
      'the network on the globe',
    )
    await bench.capture('network-globe')
  })

  test('blends endpoint colors along edges, follows sampled colors, and honors an edge override', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    const global = vscode.ConfigurationTarget.Global
    const overrides = { ...SOLID, 'network.vertexRadius': 8, 'network.edgeWidth': 6 }
    const busColor = { table: 'Bus', field: 'init.Vr' }
    const edgeColor = { table: 'Branch', field: 'params.R' }
    try {
      await bench.reset()
      for (const [key, value] of Object.entries(overrides))
        await settings.update(key, value, global)
      // One horizontal branch makes actual GPU colors measurable without other strokes,
      // selection, labels, or antialiasing obscuring its two ends and interior.
      const source = JSON.parse(bench.text)
      source.buses = source.buses.slice(0, 2).map((bus: object, index: number) => ({
        ...bus,
        init: { Vr: index, Vi: 0 },
        extension: { longitude: -5 + index * 10, latitude: 0 },
      }))
      source.devices = [
        source.devices.find((device: { class: string }) => device.class === 'Branch'),
      ]
      source.signals = []
      await bench.replace(JSON.stringify(source))
      await bench.settled()
      network = await bench.open('network')
      await vscode.commands.executeCommand('gridkitStudio.fit', bench.uri)
      await bench.page.mouse.move(0, 0)

      const colors = async (): Promise<RGB[]> => {
        await until(
          async () =>
            JSON.stringify(await network.evaluate('gridkitStats().bindings')) ===
              JSON.stringify(bench.session.bindings) &&
            (await network.evaluate<boolean>('gridkitStats().complete && gridkitStats().covered')),
          'the complete mapped network is drawn',
        )
        await idle(network)
        const points = await network.evaluate<[number, number][]>(
          'Promise.all([1, 2].map(id => gridkitLocate({ table: "Bus", id })))',
        )
        const [from, to] = points
        assert.ok(from && to, 'both endpoints are drawn')
        const png = PNG.sync.read(await network.locator('canvas').screenshot({ scale: 'css' }))
        return [0, 0.08, 0.5, 0.92, 1].map((t) => {
          const x = Math.round(from[0] + (to[0] - from[0]) * t)
          const y = Math.round(from[1] + (to[1] - from[1]) * t)
          const at = (y * png.width + x) * 4
          return [png.data[at]!, png.data[at + 1]!, png.data[at + 2]!] as const
        })
      }
      const blended = (colors: RGB[]) => {
        const [left, nearLeft, middle, nearRight, right] = colors as [RGB, RGB, RGB, RGB, RGB]
        assert.ok(apart(left, right), 'the endpoint colors differ')
        assert.ok(!apart(left, nearLeft), 'the branch starts in its first bus color')
        assert.ok(!apart(right, nearRight), 'the branch ends in its second bus color')
        assert.ok(apart(middle, left) && apart(middle, right), 'the interior blends both colors')
      }
      const plain = await colors()
      assert.ok(
        plain.every((color) => !apart(color, plain[0]!)),
        'unmapped edges match their buses',
      )
      bench.session.bind(busColor, ['vertexColor'], [0, 1])
      const mapped = await colors()
      blended(mapped)
      await bench.capture('network-endpoint-colors')

      bench.session.bind(edgeColor, ['edgeColor'], [0, 0.007])
      const overridden = await colors()
      assert.ok(!apart(overridden[1]!, overridden[3]!), 'an explicit edge mapping is uniform')
      assert.ok(apart(overridden[1]!, mapped[1]!), 'the explicit edge mapping takes precedence')
      assert.ok(!apart(overridden[0]!, mapped[0]!), 'the edge override leaves buses unchanged')
      bench.session.bind(edgeColor, [])
      const restored = await colors()
      assert.ok(
        restored.every((color, i) => !apart(color, mapped[i]!)),
        'removing it restores the blend',
      )

      const csv = vscode.Uri.joinPath(bench.uri, '..', 'endpoint-colors.csv')
      await vscode.workspace.fs.writeFile(
        csv,
        new TextEncoder().encode('time,Bus_1_Vm,Bus_2_Vm\n0,0,1\n1,1,0\n'),
      )
      await bench.session.load(csv.fsPath)
      await until(() => bench.session.results?.path === csv.fsPath, 'endpoint samples loaded')
      bench.session.bind(VM, ['vertexColor'], [0, 1])
      for (const at of [0, 1]) {
        bench.session.transport.seek(at)
        await until(() => network.evaluate<boolean>(`gridkitStats().at === ${at}`), 'seek applied')
        const sampled = await colors()
        blended(sampled)
        const expected = at === 0 ? mapped : [...mapped].reverse()
        assert.ok(
          sampled.every((color, i) => !apart(color, expected[i]!)),
          'edges follow the playhead',
        )
      }
      bench.session.bind(VM, [])
      const cleared = await colors()
      assert.ok(
        cleared.every((color, i) => !apart(color, plain[i]!)),
        'clearing restores theme colors',
      )
    } finally {
      await bench.reset()
      for (const key of Object.keys(overrides)) await settings.update(key, undefined, global)
    }
  })

  test("lays Natural Earth's borders beneath a case on Earth, once it is on screen", async () => {
    await until(
      async () =>
        (await network.evaluate<number>('gridkitStats().rows')) >
        bench.source.buses.length + bench.source.devices.length,
      'the borders drawn',
      60_000,
    )
    await bench.capture('network-borders')
  })

  test('says nothing when its editor closes as it updates', async () => {
    // VS Code closes an editor before its extension host hears so: a change made meanwhile still
    // updates the view, which must not ask the panel gone by then whether it shows. The close and
    // the change race, so they are tried as often as a few seconds allow.
    const deadline = performance.now() + 20_000
    for (let cycle = 0; cycle < 30 && performance.now() < deadline; cycle++) {
      await vscode.commands.executeCommand('vscode.openWith', bench.uri, 'gridkitStudio.network')
      // The page's own hooks are in place once it has said it is ready, before it draws.
      const page = await bench.view('network')
      await page.waitForFunction('typeof gridkitStats === "function"', undefined, {
        timeout: 30_000,
      })
      const closing = vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await pause(cycle % 4)
      try {
        bench.studio
          .get(bench.key)
          ?.bind({ table: 'Bus', field: 'init.Vr' }, cycle % 2 ? ['vertexColor'] : [])
      } catch {
        // The case closed first: nothing to map.
      }
      await closing
    }
    // What an update outlasting its editor says, it says once that update ends.
    await pause(500)
    assert.deepEqual(bench.studio.reporter.errors, [])
  })
})
