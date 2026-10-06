/** WECC240 against real GridKit: a run of voltage angle alone, mapped to vertex color and height,
 *  read back pixel by pixel from the flat and tilted network. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type ColormapName, colormaps } from '@latkit/gpu'
import { rowCount, type RowsBlock, textAt } from '@latkit/model'
import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame } from 'playwright-core'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import { recordedWhole } from '../../src/shared/bindings.js'
import { frames, idle, type TestHost, testHost, until } from './harness.js'

const VA = { type: 'Bus', field: 'Va' } as const
/** Markers and lines wide enough that their center pixels are solid, with nothing drawn over
 *  them: no labels, borders, or highlight. */
const STYLE: Record<string, unknown> = {
  'network.vertexRadiusPx': 6,
  'network.edgeWidthPx': 6,
  'network.vertices.labels': false,
  'network.borders': false,
  'network.hover': 'off',
  'network.selectedColor': '#00000000',
}
/** Closer than this, two markers or a marker and a line overlap. */
const CLEAR_PX = 14
type Point = readonly [number, number]
type RGB = readonly [number, number, number]
interface Shown {
  png: PNG
  points: Map<string, Point>
  angles: Map<string, number>
}

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])
/** How far `p` lies from the segment `a`–`b`. */
function fromSegment(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const length = dx * dx + dy * dy
  const t = length && Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
  return distance(p, [a[0] + t * dx, a[1] + t * dy])
}
function pixel(png: PNG, [x, y]: Point): RGB {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
}
/** The colormap position nearest `rgb`, and how far from it the color is, in 8-bit units. */
function onColormap(rgb: RGB, name: ColormapName): { t: number; off: number } {
  const { colors } = colormaps[name]
  let best = { t: 0, off: Infinity }
  colors.forEach((c, i) => {
    const off = Math.hypot(c[0] * 255 - rgb[0], c[1] * 255 - rgb[1], c[2] * 255 - rgb[2])
    if (off < best.off) best = { t: i / (colors.length - 1), off }
  })
  return best
}

suite('WECC240 run', function () {
  // A run of the whole case takes as long as GridKit does.
  this.timeout(600_000)
  this.bail(true)
  let bench: TestHost
  let network: Frame
  let uri: vscode.Uri
  let buses: string[]
  let branches: (readonly [string, string])[]
  /** The network as drawn, by projection and time. */
  const shown = new Map<string, Shown>()
  /** What the checks measured, kept in the run's report rather than printed. */
  const measured: Record<string, string> = {}
  const global = vscode.ConfigurationTarget.Global
  const settings = () => vscode.workspace.getConfiguration('gridkitStudio')
  const session = () => bench.studio.all.get(uri.toString())!
  const camera = () =>
    session().cameras.network as { projection?: string; pitch?: number; fit?: boolean }
  /** Each bus's recorded angle at `t`, as the views read it. */
  async function anglesAt(t: number): Promise<Map<string, number>> {
    const angles = new Map<string, number>()
    const version = bench.studio.state(uri.toString()).summary!.version
    for (let offset = 0; offset < buses.length; offset += 100) {
      const query = {
        kind: 'rows',
        from: 'Bus',
        select: ['Va'],
        ids: true,
        offset,
        limit: 100,
        at: t,
      }
      const blocks = (await bench.studio.client.call('query', {
        uri: uri.toString(),
        version,
        run: session().run!.id,
        query,
      } as never)) as RowsBlock[]
      for (const block of blocks) {
        const column = block.columns.Va as unknown as { offset: number; values: ArrayLike<number> }
        for (let i = 0; i < rowCount(block.rows); i++)
          angles.set(textAt(block.ids!, i)!, column.values[column.offset + i]!)
      }
    }
    return angles
  }
  /** The network at `t`: its pixels, where each bus is drawn on screen, and each bus's angle. */
  async function at(t: number): Promise<Shown> {
    session().transport.seek(t)
    await until(() => Math.abs(session().transport.currentT() - t) < 1e-9, `seek to ${t}`)
    await idle(network)
    const png = PNG.sync.read(await network.locator('canvas').screenshot())
    const located = await network.evaluate(
      (ids) =>
        ids.map((id) =>
          (globalThis as unknown as { gridkitLocate(id: string): Point | null }).gridkitLocate(id),
        ),
      buses,
    )
    const points = new Map<string, Point>()
    buses.forEach((id, i) => {
      const p = located[i]
      if (p && p[0] >= 8 && p[1] >= 8 && p[0] < png.width - 8 && p[1] < png.height - 8)
        points.set(id, p)
    })
    return { png, points, angles: await anglesAt(t) }
  }
  /** The buses whose markers nothing else is drawn over: another marker, or a line between others. */
  function alone({ points }: Shown): Set<string> {
    const lines = branches.filter(([a, b]) => points.has(a) && points.has(b))
    return new Set(
      [...points]
        .filter(
          ([id, p]) =>
            [...points].every(([other, q]) => other === id || distance(p, q) > CLEAR_PX) &&
            lines.every(
              ([a, b]) =>
                a === id || b === id || fromSegment(p, points.get(a)!, points.get(b)!) > 8,
            ),
        )
        .map(([id]) => id),
    )
  }

  suiteSetup(async function () {
    bench = await testHost()
    if (!(await bench.gridkit())) this.skip()
    const source = JSON.parse(
      await readFile(join(process.env.GRIDKIT_TEST_ROOT!, 'cases/WECC240.case.json'), 'utf8'),
    ) as {
      buses: { number: number }[]
      devices: { class: string; ports: Record<string, number> }[]
    }
    buses = source.buses.map(({ number }) => 'Bus/' + number)
    branches = source.devices
      .filter((device) => device.class === 'Branch')
      .map(({ ports }) => ['Bus/' + ports.bus1, 'Bus/' + ports.bus2] as const)
    for (const [key, value] of Object.entries(STYLE)) await settings().update(key, value, global)
    ;({ uri, network } = await bench.openCase('cases/WECC240.case.json'))
  })
  suiteTeardown(async () => {
    bench.report.wecc = measured
    for (const key of Object.keys(STYLE)) await settings().update(key, undefined, global)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  test('runs with Va alone, mapped to color and height on a tilted network', async () => {
    const key = uri.toString()
    bench.studio.record(key, [{ from: 'Bus', select: ['Va'] }])
    bench.studio.bind(key, VA, ['vertexColor', 'vertexHeight'])
    await network.getByRole('button', { name: 'Tilt', exact: true }).click()
    await until(() => camera()?.projection === 'tilt' && (camera().pitch ?? 0) > 0, 'tilted')
    // Moving the view by hand stops it refitting, so a bus that rises moves on screen.
    await network.locator('canvas').hover()
    await bench.page.mouse.wheel(0, -1)
    await until(() => camera().fit === false, 'the camera holds still')
    // A fault at JOHN DAY 500 kV, the case's own fault bus, cleared after 50 ms, swings the angles.
    session().values = {
      tmax: 1,
      dt_monitor: 0.01,
      fault: true,
      fault_bus: 'Bus/4005',
      fault_start: 0.1,
      fault_duration: 0.05,
    }
    const before = await frames(network)
    await vscode.commands.executeCommand('gridkitStudio.startSimulation', uri)
    await until(() => (session().run?.frames ?? 0) > 0, 'frames arrive', 180_000)
    await until(async () => (await frames(network)) > before, 'live Va frames repaint the network')
    await until(() => session().run?.state !== 'running', 'the run ends', 300_000)
    const run = session().run!
    assert.equal(run.state, 'complete', run.message)
    assert.deepEqual(
      run.outputs.map(({ from, select }) => [from, select]),
      [['Bus', ['Va']]],
    )
    assert.ok(recordedWhole(run.outputs, buses.length, VA), 'a binding draws every bus')
    assert.ok(Math.abs(run.domain[1] - 1) < 1e-9, `the run ends at ${run.domain[1]}`)
    // Run shows the Monitor; the network is read at full height, the same for every frame.
    await vscode.commands.executeCommand('workbench.action.closePanel')
    shown.set('tilt 0', await at(0))
    shown.set('tilt 0.6', await at(0.6))
    await bench.capture('run-wecc240-tilt')
    await network.getByRole('button', { name: 'Flat', exact: true }).click()
    await until(() => camera()?.projection === 'flat', 'flat')
    shown.set('flat 0.6', await at(0.6))
    await bench.capture('run-wecc240-flat')
  })

  test('each bus is colored on the colormap in step with its recorded angle', () => {
    const name = settings().get<ColormapName>('network.colormap', 'viridis')
    for (const [view, drawn] of shown) {
      const fit = [...alone(drawn)].map((id) => ({
        id,
        va: drawn.angles.get(id)!,
        ...onColormap(pixel(drawn.png, drawn.points.get(id)!), name),
      }))
      assert.ok(fit.length >= 40, `${fit.length} separate buses in ${view}`)
      const worst = fit.reduce((a, b) => (b.off > a.off ? b : a))
      assert.ok(
        worst.off < 12,
        `${worst.id} is ${worst.off.toFixed(1)} off the colormap in ${view}`,
      )
      // Over the whole run the colors span the angle's range: position is linear in angle.
      const n = fit.length
      const [mx, my] = [fit.reduce((s, f) => s + f.va, 0) / n, fit.reduce((s, f) => s + f.t, 0) / n]
      const slope =
        fit.reduce((s, f) => s + (f.va - mx) * (f.t - my), 0) /
        fit.reduce((s, f) => s + (f.va - mx) ** 2, 0)
      const residual = Math.max(...fit.map((f) => Math.abs(my + slope * (f.va - mx) - f.t)))
      measured[view + ' colors'] =
        `${n} buses, worst ${worst.off.toFixed(1)} off, residual ${residual.toFixed(4)}`
      assert.ok(slope > 0, `colors follow angle in ${view}`)
      assert.ok(residual < 0.03, `colors stray ${residual.toFixed(3)} from the angle in ${view}`)
    }
  })

  test("each unmapped branch is one color, the average of its ends'", () => {
    let total = 0
    for (const [view, drawn] of shown) {
      const { png, points } = drawn
      const clear = alone(drawn)
      const lines = branches.filter(([a, b]) => points.has(a) && points.has(b))
      let checked = 0
      for (const [a, b] of new Map(lines.map((ends) => [ends.join(), ends])).values()) {
        const [p, q] = [points.get(a)!, points.get(b)!]
        const along = [1 / 3, 1 / 2, 2 / 3].map((f): Point => [
          p[0] + f * (q[0] - p[0]),
          p[1] + f * (q[1] - p[1]),
        ])
        // Only where both ends show their own marker and nothing else crosses the line.
        if (
          !clear.has(a) ||
          !clear.has(b) ||
          distance(p, q) < 60 ||
          along.some(
            (m) =>
              [...points.values()].some((r) => distance(r, m) < 10) ||
              lines.some(
                ([c, d]) =>
                  [c, d].join() !== [a, b].join() &&
                  fromSegment(m, points.get(c)!, points.get(d)!) < 8,
              ),
          )
        )
          continue
        const [ca, cb] = [pixel(png, p), pixel(png, q)]
        const expected = ca.map((v, i) => (v + cb[i]!) / 2)
        const colors = along.map((m) => pixel(png, m))
        const off = Math.max(...colors.flatMap((c) => c.map((v, i) => Math.abs(v - expected[i]!))))
        assert.ok(
          off <= 6,
          `${a}–${b} in ${view}: [${colors.join('] [')}] along it, not the average of [${ca}] and [${cb}]`,
        )
        checked++
      }
      measured[view + ' branches'] = `${checked} one color, the average of their ends`
      assert.ok(checked >= 5, `${checked} branches checked in ${view}`)
      total += checked
    }
    // A tilted network crowds its lines; the flat one shows most of them clear.
    assert.ok(total >= 25, `${total} branches checked`)
  })

  test('a bus whose angle rises is raised on the tilted network', () => {
    const [first, last] = [shown.get('tilt 0')!, shown.get('tilt 0.6')!]
    const moved = buses
      .filter((id) => first.points.has(id) && last.points.has(id))
      .map((id) => ({
        id,
        rise: last.angles.get(id)! - first.angles.get(id)!,
        up: first.points.get(id)![1] - last.points.get(id)![1],
      }))
    const largest = Math.max(...moved.map(({ rise }) => Math.abs(rise)))
    assert.ok(largest > 1e-3, 'the fault moves the angles')
    const large = moved.filter(({ rise }) => Math.abs(rise) > largest / 4)
    measured.heights = `${large.length} buses moved by at least a quarter of ${largest.toFixed(4)} rad`
    for (const { id, rise, up } of large)
      assert.ok(
        up * rise > 0 && Math.abs(up) >= 1,
        `${id}: angle ${rise.toFixed(4)} rad, ${up.toFixed(1)} px up`,
      )
  })
})
