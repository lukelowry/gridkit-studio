/** The README's pictures, from real GridKit runs of the cases in cases/, written to docs/media. */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import type { Channel, FieldRef } from '../../src/shared/bindings.js'
import { menuContext } from '../../src/shared/contexts.js'
import { idle, pause, type Solver, type TestHost, testHost, until, visible, VM } from './harness.js'

const ROOT = process.env.GRIDKIT_TEST_ROOT!
const MEDIA = join(ROOT, 'docs/media')
const WINDOW = { width: 1280, height: 800 }
const KV = { table: 'Bus', field: 'params.kv' } as const
/** How ACTIVSg25k closes in on its fault: mouse wheel notches toward a point this many pixels
 *  above the faulted bus, which so settles low in the frame. */
const FRAMING = { notches: 4, above: 180 }

/** Run the case at `uri` with the solver file `solver` beside it, from that file's menu, and wait
 *  for the run to finish. */
async function simulate(bench: TestHost, uri: vscode.Uri, solver: Solver): Promise<void> {
  const session = bench.studio.get(uri.toString())!
  const previous = session.run?.id
  bench.run('Run Dynamic Simulation', await bench.writeSolver(solver, uri))
  await until(
    () => session.run?.id !== previous && session.run?.state !== 'running',
    'the run ends',
    900_000,
  )
  if (session.run?.state !== 'complete') throw new Error(session.run?.message ?? 'The run failed.')
}

/** A fault on `bus` from `from` to `to` through reactance `X`, as GridKit's events give it. */
const faultAt = (bus: number, [from, to]: readonly [number, number], X: number) => [
  { time: from, type: 'fault_on', bus, R: 0, X },
  { time: to, type: 'fault_off', bus },
]

/** Save the workbench below its title bar, which names the test host, once `view` settles. */
async function shoot(bench: TestHost, name: string, view: Frame): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll')
  await idle(view)
  await pause(500)
  const bar = (await bench.page.locator('.part.titlebar').boundingBox())?.height ?? 0
  await bench.page.screenshot({
    path: join(MEDIA, name + '.png'),
    clip: { x: 0, y: bar, width: WINDOW.width, height: WINDOW.height - bar },
  })
}

/** A bus of the case at `path`, from the repository root, to fault: of the highest voltage, the one
 *  with the most branches. */
async function hub(path: string): Promise<number> {
  const source = JSON.parse(await readFile(join(ROOT, path), 'utf8')) as {
    buses: { number: number; params: { kv: number } }[]
    devices: { class: string; ports: Record<string, number> }[]
  }
  const degree = new Map<number, number>()
  for (const { ports } of source.devices.filter((device) => device.class === 'Branch'))
    for (const bus of [ports.bus1!, ports.bus2!]) degree.set(bus, (degree.get(bus) ?? 0) + 1)
  const top = Math.max(...source.buses.map((bus) => bus.params.kv))
  const [best] = source.buses
    .filter((bus) => bus.params.kv === top)
    .sort((a, b) => (degree.get(b.number) ?? 0) - (degree.get(a.number) ?? 0))
  return best!.number
}

/** Show the case at `path` alone, full window, with `map` driving `channels`. */
async function show(bench: TestHost, path: string, map: FieldRef, channels: Channel[]) {
  const { uri, network } = await bench.openCase(path)
  bench.studio.get(uri.toString())!.bind(map, channels)
  await vscode.commands.executeCommand('workbench.action.closePanel')
  await vscode.commands.executeCommand('workbench.action.closeSidebar')
  return { uri, network, session: bench.studio.get(uri.toString())! }
}

/** Tilt the camera from the view's own control. */
async function tilt({ network }: Awaited<ReturnType<typeof show>>) {
  await network.getByRole('button', { name: 'Tilt', exact: true }).click()
  await until(async () => {
    const shown = await network.evaluate<{ camera: { pitch?: number } } | null>(
      'gridkitSelection()',
    )
    return (shown?.camera.pitch ?? 0) > 0
  }, 'tilted')
}

export async function run() {
  const bench = await testHost()
  // Vertices a size larger, and each picture a colormap and height of its own; every setting
  // changed is put back after, the tilt the Network's own control sets too.
  const settings = vscode.workspace.getConfiguration('gridkitStudio')
  const changed = new Set(['network.tilt'])
  const set = (key: string, value: unknown) => {
    changed.add(key)
    return settings.update(key, value, vscode.ConfigurationTarget.Global)
  }
  await set('network.colormap', 'batlow')
  await set('network.vertexRadius', 3)
  try {
    if (!(await bench.gridkit())) throw new Error('GridKit does not run here.')
    await mkdir(MEDIA, { recursive: true })
    await bench.page.setViewportSize(WINDOW)

    // ACTIVSg70k, tilted and unlabeled: each bus's voltage level as its color and, high over the
    // map, its height.
    await set('network.labels', false)
    const large = await show(bench, 'cases/ACTIVSg70k.case.json', KV, [
      'vertexColor',
      'vertexHeight',
    ])
    await tilt(large)
    await idle(large.network)
    await large.network.locator('canvas').hover()
    await bench.page.mouse.wheel(0, -240)
    await bench.page.mouse.move(0, WINDOW.height / 2)
    await shoot(bench, 'activsg70k', large.network)
    await set('network.labels', undefined)

    // ACTIVSg25k mid-fault on its busiest highest-voltage bus, framed on it: voltage magnitude as
    // color and height, so the buses the fault pulls down sink below the rest.
    await bench.reset()
    await set('network.colormap', 'spectral')
    const path = 'cases/ACTIVSg25k.case.json'
    const fault = await hub(path)
    const wide = await show(bench, path, VM, ['vertexColor', 'vertexHeight'])
    await bench.record('Bus', ['Vm'], wide.uri)
    await simulate(bench, wide.uri, {
      tmax: 1,
      dt_monitor: 0.01,
      // A fault this near to bolted takes GridKit's solver more steps between samples than it
      // allows by default.
      max_steps: 5000,
      events: faultAt(fault, [0.1, 0.2], 0.001),
    })
    await vscode.commands.executeCommand('workbench.action.closePanel')
    wide.session.transport.seek(0.15)
    await tilt(wide)
    // Fit the case, then close in over the fault, with the network it pulls down rising behind it.
    await vscode.commands.executeCommand('gridkitStudio.fit')
    await idle(wide.network)
    const canvas = (await wide.network.locator('canvas').boundingBox())!
    const [x, y] = await wide.network.evaluate(
      (id) =>
        (
          globalThis as unknown as {
            gridkitLocate(id: { table: string; id: number }): Promise<[number, number]>
          }
        ).gridkitLocate({ table: 'Bus', id }),
      fault,
    )
    await bench.page.mouse.move(canvas.x + x, canvas.y + y - FRAMING.above)
    for (let notch = 0; notch < FRAMING.notches; notch++) await bench.page.mouse.wheel(0, -120)
    await bench.page.mouse.move(0, WINDOW.height / 2)
    await shoot(bench, 'activsg25k', wide.network)
    await set('network.tilt', undefined)

    // An IEEE39 generator in the diagram, framed on its exciter and stabilizer.
    await bench.reset()
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const diagram = await bench.open('diagram')
    await vscode.commands.executeCommand('workbench.action.closePanel')
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    const generator = { table: 'Genrou', id: '30_1_genrou' }
    const drawn = async () => {
      await idle(diagram)
      const [x, y] = await until(
        () =>
          diagram.evaluate<[number, number] | null>(`gridkitLocate(${JSON.stringify(generator)})`),
        'the generator drawn',
      )
      return { x, y }
    }
    // The generator's own menu frames it: the command alone frames the Network. Then the wheel
    // closes in on it, its exciter and stabilizer either side.
    const { summary, bindings } = bench.studio.state(bench.key)
    await vscode.commands.executeCommand('gridkitStudio.zoomToNeighborhood', {
      ...menuContext(
        summary!,
        { uri: bench.key, version: summary!.version, origin: 'diagram', element: generator },
        bindings,
      ),
      webview: 'gridkitStudio.diagram',
    })
    const box = (await diagram.locator('canvas').boundingBox())!
    const { x: gx, y: gy } = await drawn()
    await bench.page.mouse.move(box.x + gx, box.y + gy)
    for (let notch = 0; notch < 4; notch++) await bench.page.mouse.wheel(0, -120)
    await bench.page.mouse.move(0, WINDOW.height / 2)
    // Nothing selected, and no focus ring from the right-click.
    await diagram.locator('canvas').blur()
    bench.session.select()
    await shoot(bench, 'diagram', diagram)

    // IEEE39 during a fault at bus 16, as its solver file has one: every bus voltage on the network
    // and in the Monitor.
    await bench.reset()
    await set('network.colormap', 'thermal')
    const ieee = await bench.open('network')
    await bench.record('Bus', ['Vm'])
    bench.session.bind(VM, ['vertexColor'])
    await simulate(bench, bench.uri, {
      tmax: 5,
      dt_monitor: 0.01,
      events: faultAt(16, [0.5, 0.6], 0.01),
    })
    bench.session.setPlots([{ from: VM.table, field: VM.field }])
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    const monitor = await bench.show('monitor')
    bench.session.transport.seek(0.55)
    await visible(monitor, 'canvas[data-rendered=true]')
    await shoot(bench, 'monitor', ieee)
    console.log('Screenshots written to ' + MEDIA)
  } finally {
    for (const key of changed) await set(key, undefined)
    await bench.browser.close()
  }
}
