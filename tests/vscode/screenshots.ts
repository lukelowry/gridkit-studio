/** The README's pictures, from real GridKit runs, written to docs/media. ACTIVSg25k and ACTIVSg70k
 *  are not among GridKit's release cases: GRIDKIT_CASES names a folder that holds them. */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import type { Channel, FieldRef } from '../../src/shared/bindings.js'
import { idle, pause, type TestHost, testHost, until, visible, VM } from './harness.js'

const MEDIA = join(process.env.GRIDKIT_TEST_ROOT!, 'docs/media')
const WINDOW = { width: 1280, height: 800 }
const KV = { type: 'Bus', field: 'params.kv' } as const
/** How ACTIVSg25k closes in on its fault: mouse wheel notches toward a point this many pixels
 *  above the faulted bus, which so settles low in the frame. */
const FRAMING = { notches: 4, above: 180 }
/** The most a VS Code extension may read as a document. */
const DOCUMENT_BYTES = 50 << 20

/** Run the case with `values`, and wait for the run to finish. */
async function simulate(
  bench: TestHost,
  uri: vscode.Uri,
  values: Record<string, unknown>,
): Promise<void> {
  const session = bench.studio.all.get(uri.toString())!
  const previous = session.run?.id
  session.values = values
  await vscode.commands.executeCommand('gridkitStudio.startSimulation', uri)
  await until(
    () => session.run?.id !== previous && session.run?.state !== 'running',
    'the run ends',
    900_000,
  )
  if (session.run?.state !== 'complete') throw new Error(session.run?.message ?? 'The run failed.')
}

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

/** The case `name` under GRIDKIT_CASES. One past what an extension may read as a document is
 *  copied without its whitespace, every string and number as written. */
async function outside(name: string): Promise<string> {
  const root = process.env.GRIDKIT_CASES
  if (!root) throw new Error('Set GRIDKIT_CASES to a folder with ACTIVSg25k and ACTIVSg70k.')
  const found = (await readdir(root, { recursive: true })).find((path) =>
    path.endsWith(name + '.case.json'),
  )
  if (!found) throw new Error(`${name}.case.json is not under ${root}.`)
  const text = await readFile(join(root, found), 'utf8')
  if (Buffer.byteLength(text) < DOCUMENT_BYTES) return join(root, found)
  let compact = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      compact += c
      if (c === '\\') compact += text[++i]
      else if (c === '"') inString = false
    } else if (c === '"') {
      compact += c
      inString = true
    } else if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') compact += c
  }
  const folder = join(process.env.GRIDKIT_TEST_OUTPUT!, 'media')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, name + '.case.json'), compact)
  return join(folder, name + '.case.json')
}

/** A bus to fault: of the highest voltage, the one with the most branches. */
async function hub(path: string): Promise<string> {
  const source = JSON.parse(await readFile(path, 'utf8')) as {
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
  return 'Bus/' + best!.number
}

/** Show the case at `path` alone, full window, with `map` driving `channels`. */
async function show(bench: TestHost, path: string, map: FieldRef, channels: Channel[]) {
  const { uri, network } = await bench.openCase(path)
  bench.studio.bind(uri.toString(), map, channels)
  await vscode.commands.executeCommand('workbench.action.closePanel')
  await vscode.commands.executeCommand('workbench.action.closeSidebar')
  return { uri, network, session: bench.studio.all.get(uri.toString())! }
}

/** Set the camera's projection from the view's own control. */
async function project(shown: Awaited<ReturnType<typeof show>>, name: 'Tilt') {
  await shown.network.getByRole('button', { name, exact: true }).click()
  await until(
    () =>
      (shown.session.cameras.network as { projection?: string })?.projection === name.toLowerCase(),
    name,
  )
}

export async function run() {
  const bench = await testHost()
  // No hover highlight under wherever the pointer was left, and vertices a size smaller; each
  // picture has a colormap of its own.
  const settings = vscode.workspace.getConfiguration('gridkitStudio')
  const global = vscode.ConfigurationTarget.Global
  const set = (key: string, value: unknown) => settings.update(key, value, global)
  const SHOWN = {
    'network.hover': 'off',
    'diagram.hover': 'off',
    'network.colormap': 'batlow',
    'network.vertexRadiusPx': 2,
    'network.zScale': 0.4,
  }
  for (const [key, value] of Object.entries(SHOWN)) await set(key, value)
  try {
    if (!(await bench.gridkit())) throw new Error('GridKit does not run here.')
    await mkdir(MEDIA, { recursive: true })
    await bench.page.setViewportSize(WINDOW)

    // ACTIVSg70k, tilted and unlabeled: each bus's voltage level as its color and, low over the
    // map, its height.
    await set('network.vertices.labels', false)
    const large = await show(bench, await outside('ACTIVSg70k'), KV, [
      'vertexColor',
      'vertexHeight',
    ])
    await project(large, 'Tilt')
    await idle(large.network)
    await large.network.locator('canvas').hover()
    await bench.page.mouse.wheel(0, -240)
    await bench.page.mouse.move(0, WINDOW.height / 2)
    await shoot(bench, 'activsg70k', large.network)
    await set('network.vertices.labels', undefined)

    // ACTIVSg25k mid-fault on its busiest highest-voltage bus, framed on it: voltage magnitude as
    // color and height, so the buses the fault pulls down sink below the rest.
    await bench.reset()
    await set('network.colormap', 'spectral')
    await set('network.zScale', 1.5)
    const path = await outside('ACTIVSg25k')
    const fault = await hub(path)
    const wide = await show(bench, path, VM, ['vertexColor', 'vertexHeight'])
    await simulate(bench, wide.uri, {
      tmax: 1,
      dt_monitor: 0.01,
      fault: true,
      fault_bus: fault,
      fault_start: 0.1,
      fault_duration: 0.1,
      fault_X: 0.001,
    })
    await vscode.commands.executeCommand('workbench.action.closePanel')
    wide.session.transport.seek(0.15)
    await project(wide, 'Tilt')
    // Fit the case, then close in over the fault, with the network it pulls down rising behind it.
    await vscode.commands.executeCommand('gridkitStudio.fit')
    await idle(wide.network)
    const canvas = (await wide.network.locator('canvas').boundingBox())!
    const [x, y] = await wide.network.evaluate(
      (id) =>
        (globalThis as unknown as { gridkitLocate(id: string): [number, number] }).gridkitLocate(
          id,
        ),
      fault,
    )
    await bench.page.mouse.move(canvas.x + x, canvas.y + y - FRAMING.above)
    for (let notch = 0; notch < FRAMING.notches; notch++) await bench.page.mouse.wheel(0, -120)
    await bench.page.mouse.move(0, WINDOW.height / 2)
    await shoot(bench, 'activsg25k', wide.network)

    // An IEEE39 generator in the diagram, framed on its exciter and stabilizer.
    await bench.reset()
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const diagram = await bench.open('diagram')
    await vscode.commands.executeCommand('workbench.action.closePanel')
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    await idle(diagram)
    bench.studio.select(bench.key, { id: 'Genrou/30_1_genrou' })
    await vscode.commands.executeCommand('gridkitStudio.neighborhood', bench.uri)
    await idle(diagram)
    bench.studio.select(bench.key, undefined)
    await shoot(bench, 'diagram', diagram)

    // IEEE39 during a fault at bus 16: every bus voltage on the network and in the Monitor, which
    // colors it the same way.
    await bench.reset()
    await set('network.colormap', 'thermal')
    const ieee = await bench.open('network')
    bench.studio.record(bench.key, [{ from: 'Bus', select: ['Vm'] }])
    bench.studio.bind(bench.key, VM, ['vertexColor'])
    await simulate(bench, bench.uri, {
      tmax: 5,
      dt_monitor: 0.01,
      fault: true,
      fault_bus: 'Bus/16',
      fault_start: 0.5,
      fault_duration: 0.1,
    })
    bench.session.plots = [{ from: VM.type, field: VM.field }]
    bench.studio.changed.fire(bench.key)
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    const monitor = await bench.show('monitor')
    bench.session.transport.seek(0.55)
    await visible(monitor, 'canvas[data-rendered=true]')
    await shoot(bench, 'monitor', ieee)
    console.log('Screenshots written to ' + MEDIA)
  } finally {
    for (const key of [...Object.keys(SHOWN), 'network.vertices.labels']) await set(key, undefined)
    await bench.browser.close()
  }
}
