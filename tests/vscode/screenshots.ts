/** The README's pictures, from real GridKit runs, written to docs/images. */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { idle, pause, type TestHost, testHost, until, visible, VM } from './harness.js'

const IMAGES = join(process.env.GRIDKIT_TEST_ROOT!, 'docs/images')
const WINDOW = { width: 1280, height: 800 }

/** Run the case with `values`, and wait for the run to finish. */
async function simulate(
  bench: TestHost,
  uri: vscode.Uri,
  values: Record<string, unknown>,
): Promise<void> {
  const session = bench.studio.all.get(uri.toString())!
  const previous = session.run?.id
  session.values = values
  await vscode.commands.executeCommand('gridkitStudio.run', uri)
  await until(
    () => session.run?.id !== previous && session.run?.state !== 'running',
    'the run ends',
    600_000,
  )
  if (session.run?.state !== 'complete') throw new Error(session.run?.message ?? 'The run failed.')
}

/** Save the workbench below its title bar, which names the test host, once `network` settles. */
async function shoot(bench: TestHost, name: string, network: Frame): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll')
  await idle(network)
  await pause(500)
  const bar = (await bench.page.locator('.part.titlebar').boundingBox())?.height ?? 0
  await bench.page.screenshot({
    path: join(IMAGES, name + '.png'),
    clip: { x: 0, y: bar, width: WINDOW.width, height: WINDOW.height - bar },
  })
}

export async function run() {
  const bench = await testHost()
  // No hover highlight under wherever the pointer was left.
  const settings = vscode.workspace.getConfiguration('gridkitStudio')
  await settings.update('network.hover', 'off', vscode.ConfigurationTarget.Global)
  try {
    if (!(await bench.gridkit())) throw new Error('GridKit does not run here.')
    await mkdir(IMAGES, { recursive: true })
    await bench.page.setViewportSize(WINDOW)

    // WECC240, tilted, swinging after a fault at JOHN DAY 500 kV: voltage angle as color and height.
    const { uri, network } = await bench.openCase('cases/WECC240.case.json')
    const key = uri.toString()
    bench.studio.record(key, [{ from: 'Bus', select: ['Va'] }])
    bench.studio.bind(key, { type: 'Bus', field: 'Va' }, ['vertexColor', 'vertexHeight'])
    await network.getByRole('button', { name: 'Tilt', exact: true }).click()
    await simulate(bench, uri, {
      tmax: 1,
      dt_monitor: 0.01,
      fault: true,
      fault_bus: 'Bus/4005',
      fault_start: 0.1,
      fault_duration: 0.05,
    })
    await vscode.commands.executeCommand('workbench.action.closePanel')
    await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
    bench.studio.all.get(key)!.transport.seek(0.6)
    // Back a notch, so the buses that rise stay in frame.
    await idle(network)
    await network.locator('canvas').hover()
    await bench.page.mouse.wheel(0, 120)
    await shoot(bench, 'network', network)

    // IEEE39 during a fault at bus 16: every bus voltage in the Monitor, and on the network.
    await bench.reset()
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
    console.log('Screenshots written to ' + IMAGES)
  } finally {
    await settings.update('network.hover', undefined, vscode.ConfigurationTarget.Global)
    await bench.browser.close()
  }
}
