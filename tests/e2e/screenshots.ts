/** Captures the README screenshots from real GridKit runs into docs/media. */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import type { Field } from '../../src/shared/document.js'
import type { Channel } from '../../src/shared/mappings.js'
import { idle, pause, type Solver, type TestHost, testHost, until, visible, VM } from './harness.js'

const ROOT = process.env.GRIDKIT_TEST_ROOT!
const MEDIA = join(ROOT, 'docs/media')
const WINDOW = { width: 1280, height: 800 }
const KV = { table: 'Bus', field: 'params.kv' } as const
/** Wheel notches to zoom in on the faulted bus from the whole ACTIVSg25k case. */
const NOTCHES_IN = 4

/** Writes `solver` beside the case, runs it from the Explorer menu, and waits for completion. */
async function simulate(bench: TestHost, uri: vscode.Uri, solver: Solver): Promise<void> {
  const session = bench.studio.get(uri.toString())!
  const previous = session.run?.id
  bench.explorer('Run Dynamic Simulation', await bench.writeSolver(solver, uri))
  await until(
    () => session.run?.id !== previous && session.run?.state !== 'running',
    'the run ends',
    900_000,
  )
  if (session.run?.state !== 'complete') throw new Error(session.run?.message ?? 'The run failed.')
}

const faultAt = (bus: number, [from, to]: readonly [number, number], X: number) => [
  { time: from, type: 'fault_on', bus, R: 0, X },
  { time: to, type: 'fault_off', bus },
]

/** Screenshots the workbench below the title bar once `view` settles. Blurring the canvas clears
 *  latkit's hover. */
async function shoot(bench: TestHost, name: string, view: Frame): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll')
  const canvas = view.locator('canvas').first()
  await canvas.focus()
  await canvas.blur()
  await idle(view)
  await pause(500)
  const bar = (await bench.page.locator('.part.titlebar').boundingBox())?.height ?? 0
  await bench.page.screenshot({
    path: join(MEDIA, name + '.png'),
    clip: { x: 0, y: bar, width: WINDOW.width, height: WINDOW.height - bar },
  })
}

/** The highest-voltage bus with the most branches in the case at `path`. */
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

async function show(bench: TestHost, path: string, map: Field, channels: Channel[]) {
  const { uri, network } = await bench.openCase(path)
  bench.studio.get(uri.toString())!.map(map, channels)
  await vscode.commands.executeCommand('workbench.action.closePanel')
  await vscode.commands.executeCommand('workbench.action.closeSidebar')
  return { uri, network, session: bench.studio.get(uri.toString())! }
}

async function tilt({ network }: Awaited<ReturnType<typeof show>>) {
  await network.getByRole('button', { name: 'Tilt', exact: true }).click()
  await until(async () => {
    const view = await network.evaluate<{ camera: { pitch?: number } } | null>('gridkitSelection()')
    return (view?.camera.pitch ?? 0) > 0
  }, 'tilted')
}

export async function run() {
  const bench = await testHost()
  // Every setting changed here is restored at the end, including the tilt the Tilt button sets.
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

    // ACTIVSg70k, tilted and unlabeled, with nominal voltage as color and height.
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

    // ACTIVSg25k mid-fault, with voltage magnitude as color and height so depressed buses sink.
    await bench.reset()
    await set('network.colormap', 'spectral')
    const path = 'cases/ACTIVSg25k.case.json'
    const fault = await hub(path)
    const wide = await show(bench, path, VM, ['vertexColor', 'vertexHeight'])
    await bench.record('Bus', ['Vm'], wide.uri)
    await simulate(bench, wide.uri, {
      tmax: 1,
      dt_monitor: 0.01,
      // A near-bolted fault needs more solver steps between samples than the default allows.
      max_steps: 5000,
      events: faultAt(fault, [0.1, 0.2], 0.001),
    })
    await vscode.commands.executeCommand('workbench.action.closePanel')
    wide.session.transport.seek(0.15)
    await tilt(wide)
    await idle(wide.network)
    // Zoom in around the faulted bus, which stays under the pointer.
    const canvas = (await wide.network.locator('canvas').boundingBox())!
    const [x, y] = await wide.network.evaluate<[number, number]>(
      `gridkitLocate({ table: 'Bus', id: ${fault} })`,
    )
    await bench.page.mouse.move(canvas.x + x, canvas.y + y)
    // Let each notch settle; a notch during another's easing counts for less.
    for (let notch = 0; notch < NOTCHES_IN; notch++) {
      await bench.page.mouse.wheel(0, -120)
      await idle(wide.network)
    }
    await bench.page.mouse.move(0, WINDOW.height / 2)
    await shoot(bench, 'activsg25k', wide.network)
    await set('network.tilt', undefined)

    // IEEE39 during a fault at bus 16, with every bus voltage in the Network and the Monitor.
    await bench.reset()
    await set('network.colormap', 'thermal')
    const ieee = await bench.open()
    await bench.record('Bus', ['Vm'])
    bench.session.map(VM, ['vertexColor'])
    await simulate(bench, bench.uri, {
      tmax: 5,
      dt_monitor: 0.01,
      events: faultAt(16, [0.5, 0.6], 0.01),
    })
    bench.session.setPlots([{ table: VM.table, field: VM.field }])
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    const monitor = await bench.show('monitor')
    bench.session.transport.seek(0.55)
    await visible(monitor, 'canvas[data-rendered=true]')
    // The Monitor shrinks the Network, so refit the case.
    await vscode.commands.executeCommand('gridkitStudio.fitAll', bench.uri)
    await shoot(bench, 'monitor', ieee)
    console.log('Screenshots written to ' + MEDIA)
  } finally {
    for (const key of changed) await set(key, undefined)
    await bench.browser.close()
  }
}
