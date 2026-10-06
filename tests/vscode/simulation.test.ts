/** The Simulation view without running GridKit: its fields, a fault's bus, the signals the next
 *  run records, and a run that cannot start. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { notifications, type TestHost, testHost, until, visible } from './harness.js'

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

  test("shows the study's typed fields and its own Run", async () => {
    await visible(simulation, '[data-testid="field-tmax"]')
    await visible(simulation, '[data-testid="simulation-start"]')
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
    const bus = signals.getByRole('treeitem', { name: /^Bus,/ }).getByRole('checkbox')
    const bused = () =>
      (bench.session.outputs ?? []).find((output) => output.from === 'Bus')?.select.length ?? 0
    const whole = (on: boolean) =>
      until(
        async () => (await bus.getAttribute('aria-checked')) === String(on),
        on ? 'Bus checked whole' : 'Bus not checked whole',
      )
    await whole(false)
    await bench.toggleSignal('Bus', 'Va')
    await until(() => !recorded(), 'a signal no longer recorded')
    await bench.toggleSignal('Bus', 'Va')
    await until(recorded, 'the signal recorded again')
    // A type's own box records all of its values, or none.
    await bus.click()
    await until(() => bused() === 4, 'every Bus value recorded')
    await whole(true)
    await bus.click()
    await until(() => bused() === 0, 'Bus recorded not at all')
    await whole(false)
  })

  test('says Run needs a signal, and opens Monitored Signals from there', async () => {
    await vscode.commands.executeCommand('gridkitStudio.clearSignals')
    await until(() => !bench.session.outputs?.length, 'nothing recorded')
    await until(
      () => simulation.locator('[data-testid="simulation-start"]').isDisabled(),
      'Run waits for a signal',
    )
    await simulation.locator('[data-testid="study-signals"]').click()
    await bench.signals({ reveal: false })
    await vscode.commands.executeCommand('gridkitStudio.selectAllSignals')
    await until(recorded, 'every signal recorded')
    simulation = await bench.show('simulation')
    await until(
      async () => !(await simulation.locator('[data-testid="simulation-start"]').isDisabled()),
      'Run ready',
    )
  })

  test('says once why a run from the Tasks menu could not start, as Run does', async () => {
    await bench.replace(bench.text.replace('{', '{,'))
    await until(() => bench.studio.state(bench.key).stale, 'the case invalid')
    const [task] = (await vscode.tasks.fetchTasks({ type: 'gridkit' })).filter(
      (task) => task.definition.case === bench.key,
    )
    assert.ok(task, 'The case offers its run as a task')
    await vscode.tasks.executeTask(task)
    const shown = await until(async () => {
      const found = await notifications()
      return found.length ? found : undefined
    }, 'why the run could not start')
    assert.equal(shown.length, 1, shown.join('\n'))
    await until(() => !bench.session.launching, 'Starting… ends')
    await bench.replace(bench.text)
    await bench.settled()
  })
})
