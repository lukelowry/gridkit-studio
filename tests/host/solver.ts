import * as assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Browser, Page } from 'playwright-core'
import * as vscode from 'vscode'

import { until } from './wait.js'

export async function runSolverSlice(browser: Browser, workbench: Page, output: string) {
  const folder = vscode.workspace.workspaceFolders![0].uri
  const extension = vscode.extensions.getExtension('lukelowery.gridkit-studio')!
  for (const name of ['two-bus.case.json', 'two-bus.solver.json'])
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(folder, name),
      await readFile(join(extension.extensionUri.fsPath, 'tests/fixtures/solver', name)),
    )
  const solver = vscode.Uri.joinPath(folder, 'two-bus.solver.json')
  const caseUri = vscode.Uri.joinPath(folder, 'two-bus.case.json')
  const before = await vscode.workspace.fs.readFile(caseUri)
  await vscode.commands.executeCommand('gridkitStudio.preview', caseUri)
  const complete = new Promise<number | undefined>((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.definition.type === 'gridkit') {
        sub.dispose()
        resolve(event.exitCode)
      }
    })
  })
  await vscode.commands.executeCommand('gridkitStudio.runSolver', solver)
  assert.equal(
    await Promise.race([
      complete,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 45000)),
    ]),
    0,
  )
  await browser.contexts()[0].addInitScript({
    content: `
    const NativeObserver = IntersectionObserver;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) {
        super(callback, options);
        window.cycleMonitorVisibility = element => {
          callback([false, true, false, true].map(isIntersecting => ({target: element, isIntersecting})), this);
        };
      }
    };
  `,
  })
  await vscode.commands.executeCommand('gridkitStudio.openMonitor')
  const find = async (selector: string) => {
    for (const page of browser.contexts().flatMap((context) => context.pages()))
      for (const frame of page.frames()) {
        try {
          if (await frame.locator(selector).count()) return frame
        } catch {
          /* Frame replaced. */
        }
      }
  }
  let monitor = (await until(() => find('.trace'), Boolean))!
  assert.ok(
    (await workbench.locator('.part.panel').getByText('Monitor', { exact: true }).count()) > 0,
    'Monitor must be in the bottom panel',
  )
  try {
    await monitor.locator('body[data-state="ready"]').waitFor({ timeout: 30000 })
  } catch (error) {
    console.error('Monitor state:', await monitor.locator('main').innerText())
    throw error
  }
  await until(
    () => monitor.locator('.trace').getAttribute('data-samples'),
    (value) => Number(value) > 0,
  )
  assert.equal(await monitor.locator('body').getAttribute('data-field'), 'Vm')
  await monitor.evaluate('window.cycleMonitorVisibility(document.querySelector(".lane"))')
  await monitor.locator('.trace[aria-busy="false"]').waitFor()
  assert.equal(
    await monitor.locator('.error').isHidden(),
    true,
    'A cancelled attachment must retry when the lane is visible again',
  )

  await monitor.locator('.trace').click({ position: { x: 100, y: 60 } })
  await until(
    () => monitor.locator('.reading').innerText(),
    (text) => text.length > 0,
  )
  const selected = await until(
    () => monitor.locator('.trace').getAttribute('data-vscode-context'),
    (text) => !!text && !!JSON.parse(text).gridkitTarget.element,
  )
  const target = JSON.parse(selected!).gridkitTarget
  assert.equal(target.field.source, 'signal')
  const binding = vscode.commands.executeCommand('gridkitStudio.bind', {
    target,
    channel: 'vertexColor',
  })
  const fieldChoice = workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'Vm' })
  await fieldChoice.first().click()
  await binding
  await vscode.commands.executeCommand('gridkitStudio.showInTable', { gridkitTarget: target })
  const table = (await until(() => find('#table'), Boolean))!
  assert.ok(
    (await workbench.locator('.part.panel').getByText('Case', { exact: true }).count()) > 0,
    'Case must be in the bottom panel',
  )
  await table.locator('[role="columnheader"]').filter({ hasText: 'Vm' }).waitFor()
  try {
    await until(
      () => table.locator('[role="row"][aria-selected="true"]').count(),
      (count) => count === 1,
    )
  } catch (error) {
    console.error('Linked table:', target, await table.locator('main').innerText())
    throw error
  }
  await vscode.commands.executeCommand('gridkitStudio.openMonitor')
  monitor = (await until(() => find('.trace'), Boolean))!
  await monitor.locator('body[data-state="ready"]').waitFor()
  await monitor.locator('.trace').focus()
  await monitor.locator('.trace').press('End')
  await until(
    () => monitor.locator('#time-axis').getAttribute('aria-valuenow'),
    (text) => text === '2',
  )
  const windowInput = workbench
    .locator('.quick-input-widget input:not([type="checkbox"]):visible')
    .first()
  const setWindow = async (value: string, expected: string[]) => {
    const command = vscode.commands.executeCommand('gridkitStudio.monitorWindow')
    await windowInput.fill(value)
    await windowInput.press('Enter')
    await command
    await until(
      () => monitor.locator('#time-axis').getAttribute('title'),
      (title) => !!title?.startsWith(`${expected[0]} to ${expected.at(-1)} seconds. Drag to seek.`),
    )
    const values = await monitor
      .locator('#time-ticks .tick')
      .evaluateAll((labels) => labels.map((label) => Number(label.getAttribute('title'))))
    assert.ok(values.length > 1)
    assert.ok(
      values.every((value) => value >= Number(expected[0]) && value <= Number(expected.at(-1))),
    )
  }
  await vscode.commands.executeCommand('notifications.clearAll')
  await setWindow('0.5, 1.5', ['0.5', 'Time (s)', '1.5'])
  await until(() => monitor.locator('.cursor').isHidden(), Boolean)
  await monitor.locator('main').screenshot({ path: join(output, 'monitor-window.png') })
  await setWindow('', ['0', 'Time (s)', '2'])
  await until(() => monitor.locator('.cursor').isVisible(), Boolean)
  const ruler = monitor.locator('#time-axis')
  await vscode.commands.executeCommand('notifications.clearAll')
  const bounds = (await ruler.boundingBox())!
  await workbench.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + 10)
  await workbench.mouse.down()
  await workbench.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + 10, { steps: 5 })
  await workbench.mouse.up()
  await until(
    () => ruler.getAttribute('aria-valuenow'),
    (value) => Math.abs(Number(value) - 1.3) < 0.03,
  )
  await ruler.focus()
  await ruler.press('End')
  await until(
    () => ruler.getAttribute('aria-valuenow'),
    (value) => value === '2',
  )
  await vscode.commands.executeCommand('gridkitStudio.retryMonitor')
  await monitor.locator('.trace[data-samples]').waitFor()
  await vscode.commands.executeCommand('gridkitStudio.plot', {
    gridkitTarget: {
      ...target,
      element: undefined,
      field: { classId: 'genrou', source: 'signal', id: 'speed' },
    },
  })
  await until(
    () => monitor.locator('.lane').count(),
    (count) => count === 2,
  )
  const speed = monitor.locator('.lane[data-field="speed"]')
  await speed.scrollIntoViewIfNeeded()
  await until(
    () => speed.locator('.trace').getAttribute('data-samples'),
    (value) => Number(value) > 0,
  )
  const canvas = await monitor.locator('.lane[data-field="Vm"] .trace').elementHandle()
  const caseDocument = await vscode.workspace.openTextDocument(caseUri)
  const monitoredCase = JSON.parse(caseDocument.getText())
  monitoredCase.buses[0].mon = []
  const monitoring = new vscode.WorkspaceEdit()
  monitoring.replace(
    caseUri,
    new vscode.Range(
      caseDocument.positionAt(0),
      caseDocument.positionAt(caseDocument.getText().length),
    ),
    JSON.stringify(monitoredCase, null, 2),
  )
  assert.equal(await vscode.workspace.applyEdit(monitoring), true)
  await until(
    () => monitor.locator('.trace').first().getAttribute('data-vscode-context'),
    (context) => !!context && JSON.parse(context).gridkitTarget.version === caseDocument.version,
  )
  assert.equal(
    await canvas!.evaluate((node) => node.isConnected),
    true,
    'Monitoring edits must retain the plot instance',
  )
  assert.equal(await monitor.locator('.lane[data-field="Vm"] .error').isHidden(), true)
  console.log('PASS monitoring-only edits retain the active plot and its samples')
  await vscode.commands.executeCommand('notifications.clearAll')
  await speed.screenshot({ path: join(output, 'monitor-second-field.png') })
  await monitor.locator('.lane[data-field="Vm"]').scrollIntoViewIfNeeded()
  await vscode.commands.executeCommand('notifications.clearAll')
  await monitor.locator('main').screenshot({ path: join(output, 'monitor.png') })
  await workbench.screenshot({ path: join(output, 'monitor-workbench.png') })
  await workbench.setViewportSize({ width: 900, height: 700 })
  await monitor.locator('main').screenshot({ path: join(output, 'monitor-narrow.png') })
  await workbench.setViewportSize({ width: 1280, height: 900 })
  const previousTheme = vscode.workspace.getConfiguration('workbench').get('colorTheme')
  for (const [theme, name] of [
    ['Default Light Modern', 'monitor-light'],
    ['Default High Contrast', 'monitor-contrast'],
  ] as const) {
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', theme, vscode.ConfigurationTarget.Global)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await monitor.locator('main').screenshot({ path: join(output, `${name}.png`) })
  }
  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global)
  const csvBefore = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'mon.csv'))
  await vscode.commands.executeCommand('gridkitStudio.clearRun')
  await monitor.locator('.plot-status').first().filter({ hasText: 'Not monitored.' }).waitFor()
  assert.equal(await monitor.locator('.lane').count(), 2, 'Clearing samples keeps explicit plots')
  assert.equal(await monitor.locator('.trace:visible').count(), 0)
  assert.equal(await monitor.locator('#time-ruler').isHidden(), true)
  await monitor.locator('main').screenshot({ path: join(output, 'monitor-no-samples.png') })
  assert.deepEqual(
    await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'mon.csv')),
    csvBefore,
  )
  assert.deepEqual(await vscode.workspace.fs.readFile(caseUri), before)
  console.log(
    'PASS native solver Task, Monitor, shared selection/time, recorded table fields, and transient cleanup',
  )
}
