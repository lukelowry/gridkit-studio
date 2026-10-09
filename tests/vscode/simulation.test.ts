/** The Simulation view without running GridKit: its fields, a fault's bus, the signals the next
 *  run records, and a run that cannot start. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { notified, type TestHost, testHost, until, visible } from './harness.js'

suite('Simulation', () => {
  let bench: TestHost
  let simulation: Frame
  const recorded = () =>
    (bench.session.outputs ?? []).some(
      (output) => output.from === 'Bus' && output.select.includes('Va'),
    )

  suiteSetup(async () => {
    bench = await testHost()
    simulation = await bench.show('simulation')
  })

  test('shows its typed fields, and Start in its title bar', async () => {
    await visible(simulation, '[data-testid="field-tmax"]')
    // A side bar view shows its title bar's actions while the pointer is over its header.
    const header = bench.page.locator('.pane-header', { hasText: /^Simulation/ })
    await header.hover()
    await header.getByRole('button', { name: /^Start Simulation/ }).waitFor()
    // Its title bar starts the run; the form has no Start of its own.
    assert.equal(await simulation.getByRole('button', { name: /^Start/ }).count(), 0)
    await bench.capture('simulation-vscode')
  })

  test("picks a fault's bus from the case's own", async () => {
    await simulation.locator('[data-testid="field-fault"]').click()
    await simulation.locator('[data-testid="field-fault_bus"]').click()
    await simulation.locator('[role="option"]').nth(2).click()
    await until(
      () => /^Bus\//.test(String(bench.session.values.fault_bus ?? '')),
      'a fault bus picked from the list',
    )
    await simulation.locator('[data-testid="field-fault"]').click()
    await until(() => bench.session.values.fault === false, 'the fault switched off')
  })

  test('chooses which signals the next run records in its own native view', async () => {
    // A case records its buses' voltage magnitude and angle until the user chooses otherwise.
    assert.deepEqual(bench.session.outputs, [{ from: 'Bus', select: ['Vm', 'Va'] }])
    const signals = await bench.signals()
    const bused = () =>
      (bench.session.outputs ?? []).find((output) => output.from === 'Bus')?.select.length ?? 0
    // Only fields are checked off; a type says how many of its fields are, and has no box.
    const bus = signals.getByRole('treeitem', { name: /^Bus,/ })
    await until(
      async () => /2 of \d+ recorded/.test((await bus.getAttribute('aria-label')) ?? ''),
      'Bus counts its fields',
    )
    assert.equal(await bus.getByRole('checkbox').count(), 0)
    await bench.toggleSignal('Bus', 'Va')
    await until(() => !recorded(), 'a signal no longer recorded')
    await bench.toggleSignal('Bus', 'Va')
    await until(recorded, 'the signal recorded again')
    // The view's title bar records every field, or none.
    await bench.title('signals', 'Record All Signals')
    await until(() => bused() > 2, 'every Bus value recorded')
    await bench.title('signals', 'Record No Signals')
    await until(() => bused() === 0, 'Bus recorded not at all')
  })

  test('says in a notification what keeps Start from running, and nothing in the form', async () => {
    await vscode.commands.executeCommand('gridkitStudio.clearSignals')
    await until(() => !bench.session.outputs?.length, 'nothing recorded')
    await bench.start()
    // Nothing recorded: the notification offers Monitored Signals.
    await bench.notice('Choose Signals').click()
    await bench.signals({ reveal: false })
    await vscode.commands.executeCommand('gridkitStudio.selectAllSignals')
    await until(recorded, 'every signal recorded')
    // A value that cannot run is outlined in the form, and said by Start.
    simulation = await bench.show('simulation')
    const tmax = simulation.locator('[data-testid="field-tmax"]')
    const before = await tmax.inputValue()
    await tmax.fill('soon')
    await until(async () => (await tmax.getAttribute('aria-invalid')) === 'true', 'outlined')
    assert.equal(await simulation.locator('.c-note').count(), 0)
    await bench.start()
    const shown = await notified('why Start could not run')
    assert.equal(shown.length, 1, shown.join('\n'))
    assert.equal(bench.session.launching, false)
    assert.equal(bench.studio.errors.splice(0).length, 2)
    await tmax.fill(before)
    await until(async () => (await tmax.getAttribute('aria-invalid')) === 'false', 'fixed')
  })

  test('says once why a run from the Tasks menu could not start, as Run does', async () => {
    // Nothing recorded keeps the run from starting. The case is left as it is, since VS Code
    // saves every edited file before it runs a task.
    await vscode.commands.executeCommand('gridkitStudio.clearSignals')
    await until(() => !bench.session.outputs?.length, 'nothing recorded')
    const [task] = (await vscode.tasks.fetchTasks({ type: 'gridkit' })).filter(
      (task) => task.definition.case === bench.key,
    )
    assert.ok(task, 'The case offers its run as a task')
    await vscode.tasks.executeTask(task)
    const shown = await notified('why the run could not start')
    assert.equal(shown.length, 1, shown.join('\n'))
    await until(() => !bench.session.launching, 'Starting… ends')
    assert.equal(bench.studio.errors.splice(0).length, 1)
  })
})
