import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'

import { type TestHost, testHost, until, visible } from './harness.js'

suite('DynamicSimulation', () => {
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
    await visible(simulation, '[data-testid="study-run"]')
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

  test('chooses which signals the next run records', async () => {
    assert.ok(recorded())
    await simulation.getByRole('button', { name: 'Monitored signals', exact: true }).click()
    await simulation.locator('[data-testid="monitor-class-Bus"]').click()
    await simulation.locator('[data-testid="monitor-Bus-Va"]').click()
    await until(() => !recorded(), 'a signal no longer recorded')
    await simulation.locator('[data-testid="monitor-Bus-Va"]').click()
    await until(recorded, 'the signal recorded again')
  })
})
