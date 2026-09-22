import * as assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Browser, Frame, Page } from 'playwright-core'
import * as vscode from 'vscode'

import { changeJson, nativeCaseEdits } from '../../src/gridkit/edit.js'
import { until } from './wait.js'

export async function runSimulationWorkflow(browser: Browser, workbench: Page, output: string) {
  const folder = vscode.workspace.workspaceFolders![0].uri
  const extension = vscode.extensions.getExtension('lukelowery.gridkit-studio')!
  const uri = vscode.Uri.joinPath(folder, 'bare.case.json')
  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(
      changeJson(
        await readFile(
          join(extension.extensionUri.fsPath, 'tests/fixtures/solver/two-bus.case.json'),
          'utf8',
        ),
        ['devices', 2, 'params', 'R'],
        0,
      ),
    ),
  )
  const document = await vscode.workspace.openTextDocument(uri)
  await vscode.commands.executeCommand('gridkitStudio.preview', uri)
  await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
  const sidebar = workbench.locator('.part.sidebar')
  const frames = async (selector: string): Promise<Frame | undefined> => {
    for (const page of browser.contexts().flatMap((context) => context.pages()))
      for (const frame of page.frames()) {
        try {
          if (await frame.locator(selector).count()) return frame
        } catch {
          /* View replaced. */
        }
      }
  }
  const simulation = (await until(() => frames('#simulation'), Boolean))!
  await simulation.getByText('Unsaved configuration', { exact: true }).waitFor()
  await simulation.locator('input[name="tmax"]').click()
  await simulation.locator('input[name="tmax"]').fill('0.1')
  await simulation.getByText('Solver options', { exact: true }).click()
  await simulation.locator('select[name="max_order"]').selectOption('2')
  await simulation.getByRole('button', { name: 'Apply', exact: true }).click()
  await until(
    () => simulation.getByRole('button', { name: 'Apply', exact: true }).count(),
    (count) => count === 0,
  )
  assert.equal(await simulation.locator('select[name="max_order"]').inputValue(), '2')
  const addFault = vscode.commands.executeCommand('gridkitStudio.addFault')
  await workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'Bus 0' })
    .first()
    .click()
  await addFault
  await simulation.locator('input[name="fault-start"]').click()
  await simulation.locator('input[name="fault-start"]').fill('0.')
  const other = vscode.Uri.joinPath(folder, 'draft-other.case.json')
  const draftCase = JSON.parse(document.getText())
  draftCase.header.case_name = 'Other case'
  await vscode.workspace.fs.writeFile(other, new TextEncoder().encode(JSON.stringify(draftCase)))
  await vscode.commands.executeCommand('gridkitStudio.preview', other)
  await simulation.locator('.case-name').filter({ hasText: 'Other case' }).waitFor()
  assert.equal(await simulation.locator('input[name="fault-start"]').count(), 0)
  await vscode.commands.executeCommand('gridkitStudio.preview', uri)
  await simulation.locator('input[name="fault-start"]').waitFor()
  assert.equal(await simulation.locator('input[name="fault-start"]').inputValue(), '0.')
  console.log('PASS case switching preserves unfinished fault input')
  await simulation.locator('input[name="fault-start"]').click()
  await simulation.locator('input[name="fault-start"]').fill('0.02')
  await simulation.locator('input[name="fault-duration"]').fill('0.3')
  await simulation.getByText('The fault must clear by 0.1 s.').waitFor()
  assert.equal(
    await simulation.getByRole('button', { name: 'Add Fault', exact: true }).isDisabled(),
    true,
  )
  await simulation.locator('input[name="fault-duration"]').fill('0.03')
  await simulation.getByText('Clears at 0.05 s', { exact: true }).waitFor()
  await workbench.screenshot({ path: join(output, 'fault-editor.png') })
  const theme = vscode.workspace.getConfiguration('workbench')
  await theme.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global)
  await simulation.locator('body.vscode-light').waitFor()
  // Native resize actions avoid trapping webview pointer input during synthetic sash drags.
  await sidebar.locator('.pane-header').first().focus()
  const sidebarBox = (await sidebar.boundingBox())!
  await vscode.commands.executeCommand('workbench.action.decreaseViewSize')
  const narrowBox = await until(
    () => sidebar.boundingBox(),
    (box) => !!box && box.width < sidebarBox.width,
  )
  await workbench.screenshot({ path: join(output, 'fault-editor-narrow-light.png') })
  assert.equal(
    await simulation.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth),
    true,
  )
  await vscode.commands.executeCommand('workbench.action.increaseViewSize')
  await until(
    () => sidebar.boundingBox(),
    (box) => !!box && box.width > narrowBox!.width,
  )
  await theme.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global)
  await simulation.locator('body.vscode-dark').waitFor()
  await simulation.getByRole('button', { name: 'Add Fault', exact: true }).click()
  await simulation.getByText(/0.02.*0.05 s/).waitFor()
  assert.match(document.getText(), /"R": 0\.0/)
  assert.equal(JSON.parse(document.getText()).devices.at(-1).id, 'fault_1')
  await simulation.getByRole('button', { name: 'Edit', exact: true }).click()
  await simulation.locator('input[name="fault-duration"]').fill('0.04')
  await simulation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await simulation.getByText(/0.02.*0.05 s/).waitFor()
  await workbench.screenshot({ path: join(output, 'fault-sidebar.png') })
  await vscode.commands.executeCommand('gridkitStudio.signals.focus')
  await sidebar.getByText('Bus', { exact: true }).click()
  const va = sidebar.locator('.monaco-list-row').filter({ hasText: /^Va/ })
  await va.getByRole('checkbox').click()
  await until(
    () =>
      JSON.parse(document.getText()).buses.every((bus: { mon?: string[] }) =>
        bus.mon?.includes('Va'),
      ),
    Boolean,
  )
  assert.equal(document.isDirty, true, 'Signal selection must be an undoable document edit')
  await sidebar.getByText('Network bindings', { exact: true }).click()
  const run = async () => {
    const done = new Promise<number | undefined>((resolve) => {
      const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task.definition.type === 'gridkit') {
          subscription.dispose()
          resolve(event.exitCode)
        }
      })
    })
    await vscode.commands.executeCommand('gridkitStudio.runSolver', uri)
    assert.equal(
      await Promise.race([
        done,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 45000)),
      ]),
      0,
    )
    assert.equal(
      (await vscode.workspace.fs.readDirectory(folder)).some(([name]) =>
        name.startsWith('.gridkit-'),
      ),
      false,
      'Temporary solver input must be removed',
    )
  }
  await run()
  assert.equal(document.isDirty, false)
  await vscode.commands.executeCommand('gridkitStudio.openMonitor')
  let monitor = (await until(() => frames('.trace'), Boolean))!
  await monitor.locator('body[data-state="ready"]').waitFor()
  const target = JSON.parse(
    (await monitor.locator('.trace').first().getAttribute('data-vscode-context'))!,
  ).gridkitTarget
  const binding = vscode.commands.executeCommand('gridkitStudio.bind', {
    target,
    channel: 'vertexColor',
  })
  await workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'Vm' })
    .first()
    .click()
  await binding
  const network = (await until(() => frames('#network'), Boolean))!
  await until(
    () => network.locator('#network').getAttribute('data-bindings'),
    (value) => !!value?.includes('vertexColor'),
  )
  const displayConfiguration = vscode.workspace.getConfiguration('gridkitStudio', uri)
  assert.equal(displayConfiguration.get('branchColorsFromBuses'), true)
  await displayConfiguration.update(
    'branchColorsFromBuses',
    false,
    vscode.ConfigurationTarget.Workspace,
  )
  await until(
    () => network.locator('#network').getAttribute('data-branch-colors-from-buses'),
    (value) => value === 'false',
  )
  await displayConfiguration.update(
    'branchColorsFromBuses',
    true,
    vscode.ConfigurationTarget.Workspace,
  )
  await until(
    () => network.locator('#network').getAttribute('data-branch-colors-from-buses'),
    (value) => value === 'true',
  )
  await run()
  await until(
    () => network.locator('#network').getAttribute('data-bindings'),
    (value) => !!value?.includes('vertexColor'),
  )
  await vscode.commands.executeCommand('gridkitStudio.openMonitor')
  monitor = (await until(() => frames('.trace'), Boolean))!
  await monitor.locator('body[data-state="ready"]').waitFor()
  await until(
    () => monitor.locator('.event-marker').count(),
    (count) => count === 2,
  )
  await monitor.locator('#time-axis').dispatchEvent('wheel', { ctrlKey: true, deltaY: -100 })
  await until(
    () => monitor.locator('#time-axis').getAttribute('title'),
    (title) => !!title && !title.startsWith('0 to 0.1 seconds'),
  )
  await vscode.commands.executeCommand('gridkitStudio.resetMonitorWindow')
  await until(
    () => monitor.locator('#time-axis').getAttribute('title'),
    (title) => !!title?.startsWith('0 to 0.1 seconds'),
  )
  await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
  await vscode.commands.executeCommand('notifications.clearAll')
  await workbench.screenshot({ path: join(output, 'fault-monitor.png') })
  await vscode.commands.executeCommand('gridkitStudio.nextSample')
  await until(
    () => monitor.locator('#time-axis').getAttribute('aria-valuenow'),
    (text) => !!text?.includes('0.004166'),
  )
  await vscode.commands.executeCommand('gridkitStudio.clearRun')
  const csv = vscode.Uri.joinPath(folder, 'mon.csv')
  const before = await vscode.workspace.fs.readFile(csv)
  const opening = vscode.commands.executeCommand('gridkitStudio.openCsv', csv)
  await workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'bare.case.json' })
    .click()
  await opening
  monitor = (await until(() => frames('.trace'), Boolean))!
  await monitor.locator('body[data-state="ready"]').waitFor()
  assert.deepEqual(await vscode.workspace.fs.readFile(csv), before)
  await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
  await vscode.commands.executeCommand('notifications.clearAll')
  await workbench.screenshot({ path: join(output, 'simulation-workbench.png') })
  await sidebar.screenshot({ path: join(output, 'simulation-sidebar.png') })
  await workbench.setViewportSize({ width: 900, height: 700 })
  await workbench.screenshot({ path: join(output, 'simulation-narrow.png') })
  await workbench.setViewportSize({ width: 1280, height: 900 })
  // A drag must end when another case replaces the displayed source.
  const ruler = monitor.locator('#time-axis')
  await ruler.evaluate((element) =>
    element.addEventListener('pointerdown', (event: { pointerId: number }) => {
      element.setAttribute('data-test-pointer', String(event.pointerId))
    }),
  )
  await ruler.hover({ position: { x: 32, y: 12 } })
  const mouse = monitor.page().mouse
  await mouse.down()
  await until(
    () =>
      ruler.evaluate((element) =>
        element.hasPointerCapture(Number(element.getAttribute('data-test-pointer'))),
      ),
    Boolean,
  )
  const otherCase = vscode.Uri.joinPath(folder, 'two-bus.case.json')
  await vscode.commands.executeCommand('gridkitStudio.preview', otherCase)
  await until(
    () => monitor.locator('body').getAttribute('data-case'),
    (value) => value === otherCase.toString(),
  )
  assert.equal(
    await ruler.evaluate((element) =>
      element.hasPointerCapture(Number(element.getAttribute('data-test-pointer'))),
    ),
    false,
  )
  await mouse.up()
  await runLargeCases(browser, workbench)
  await runFailure(browser, workbench, output)
  console.log(
    'PASS Simulation form, signal checkbox edits, case-only execution, rerun binding retention, exact stepping, and existing CSV opening',
  )
}

async function runLargeCases(browser: Browser, workbench: Page): Promise<void> {
  const extension = vscode.extensions.getExtension('lukelowery.gridkit-studio')!
  const folder = vscode.workspace.workspaceFolders![0].uri
  for (const name of ['ACTIVSg200', 'ACTIVSg2000']) {
    const uri = vscode.Uri.joinPath(folder, name + '.case.json')
    const source = await readFile(
      join(extension.extensionUri.fsPath, 'cases', name + '.case.json'),
      'utf8',
    )
    const index = JSON.parse(source).devices.findIndex(
      (device: { class: string }) => device.class === 'BusFault',
    )
    const text = changeJson(source, ['devices', index, 'params', 'R'], 0)
    assert.ok(nativeCaseEdits(text, JSON.parse(text)).length > 0)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text))
    const solverUri = vscode.Uri.joinPath(folder, name + '.solver.json')
    await vscode.workspace.fs.writeFile(
      solverUri,
      Buffer.from(
        JSON.stringify({
          system_model_file: name + '.case.json',
          output_file: name + '.mon.csv',
          tmax: 2,
          dt_monitor: 0.01,
          events: [
            { time: 1, type: 'fault_on', element_id: 0 },
            { time: 1.15, type: 'fault_off', element_id: 0 },
          ],
        }),
      ),
    )
    await vscode.commands.executeCommand('gridkitStudio.preview', uri)
    await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
    const simulation = await until(async () => {
      for (const page of browser.contexts().flatMap((context) => context.pages()))
        for (const frame of page.frames())
          try {
            if (await frame.locator('#simulation').count()) return frame
          } catch {}
    }, Boolean)
    await until(
      () => simulation!.locator('.case-name').textContent(),
      (value) => value === JSON.parse(text).header.case_name,
    )
    const ended = new Promise<number | undefined>((resolve) => {
      const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task.definition.solver !== name + '.solver.json') return
        subscription.dispose()
        resolve(event.exitCode)
      })
    })
    await vscode.commands.executeCommand('gridkitStudio.runSolver', solverUri)
    const code = await Promise.race([
      ended,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 90000)),
    ])
    assert.equal(code, 0, name + ' fault simulation must complete')
    const saved = await readFile(uri.fsPath, 'utf8')
    assert.deepEqual(JSON.parse(saved), JSON.parse(text))
    assert.deepEqual(nativeCaseEdits(saved, JSON.parse(saved)), [])
    console.log(
      'PASS ' +
        name +
        ' fault with automatic numeric formatting via native Task and latest GridKit image',
    )
  }
  await workbench.locator('.part.sidebar').waitFor()
}

async function runFailure(browser: Browser, workbench: Page, output: string): Promise<void> {
  const extension = vscode.extensions.getExtension('lukelowery.gridkit-studio')!
  const folder = vscode.workspace.workspaceFolders![0].uri
  const uri = vscode.Uri.joinPath(folder, 'invalid-parameter.case.json')
  const text = (
    await readFile(
      join(extension.extensionUri.fsPath, 'tests/fixtures/solver/two-bus.case.json'),
      'utf8',
    )
  ).replace(/"H"\s*:\s*3\.0/, '"H":true')
  assert.ok(text.includes('"H":true'))
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text))
  await vscode.commands.executeCommand('gridkitStudio.preview', uri)
  const ended = new Promise<number | undefined>((resolve) => {
    const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.definition.case !== 'invalid-parameter.case.json') return
      subscription.dispose()
      resolve(event.exitCode)
    })
  })
  await vscode.commands.executeCommand('gridkitStudio.runSolver', uri)
  assert.equal(await ended, 1)
  await workbench
    .getByText('GridKit: $.devices[1].params.H must be a number', { exact: true })
    .first()
    .waitFor()
  console.log('PASS invalid native parameter rejected before execution with its source path')
  await vscode.commands.executeCommand('notifications.clearAll')

  const runtimeCase = vscode.Uri.joinPath(folder, 'solver-failure.case.json')
  const runtimeSolver = vscode.Uri.joinPath(folder, 'solver-failure.solver.json')
  await vscode.workspace.fs.writeFile(runtimeCase, Buffer.from(text.replace('"H":true', '"H":3.0')))
  await vscode.workspace.fs.writeFile(
    runtimeSolver,
    Buffer.from(
      JSON.stringify({
        system_model_file: 'solver-failure.case.json',
        tmax: 1,
        dt_monitor: 0.01,
        max_steps: 1,
        events: [],
      }),
    ),
  )
  await vscode.commands.executeCommand('gridkitStudio.preview', runtimeCase)
  const failed = new Promise<number | undefined>((resolve) => {
    const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.definition.solver !== 'solver-failure.solver.json') return
      subscription.dispose()
      resolve(event.exitCode)
    })
  })
  await vscode.commands.executeCommand('gridkitStudio.runSolver', runtimeSolver)
  assert.equal(await failed, 1)
  await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
  const simulation = (await until(async () => {
    for (const page of browser.contexts().flatMap((context) => context.pages()))
      for (const frame of page.frames())
        try {
          if (await frame.locator('#simulation').count()) return frame
        } catch {}
  }, Boolean))!
  await until(
    () => simulation.locator('.notice').first().textContent(),
    (value) => !!value && /IDA|mxstep|steps/i.test(value),
  )
  await vscode.commands.executeCommand('gridkitStudio.showSolverOutput')
  assert.ok(
    vscode.window.activeTerminal?.name.endsWith('solver-failure.solver.json'),
    'Show Terminal must reveal this run, not another task',
  )
  await workbench.screenshot({ path: join(output, 'simulation-error.png') })
  console.log('PASS actual GridKit integration failure in Simulation and originating task terminal')
}
