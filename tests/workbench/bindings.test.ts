import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { until, visible, VM, type Workbench, workbench } from './harness.js'

suite('Mappings', () => {
  let bench: Workbench
  let mappings: Frame
  const bound = () => mappings.locator('.bindings__field--bound').count()

  suiteSetup(async () => {
    bench = await workbench()
    mappings = await bench.show('bindings')
  })

  test("stages a field's channels and applies them at once", async () => {
    await mappings.locator('[data-testid="bindings-link-Bus-column-kv"]').click()
    await visible(mappings, '[data-testid="binding-editor"]')
    await mappings.locator('[data-testid="binding-vertexColor"]').check()
    assert.deepEqual(bench.session.bindings, {})
    await mappings.locator('[data-testid="binding-apply"]').click()
    await until(() => bench.session.bindings.vertexColor?.field === 'kv', 'the mapping applied')
    assert.equal(await mappings.locator('[data-testid="binding-editor"]').count(), 0)
    await bench.capture('mappings-workbench')
  })

  test('unbinds a field from its command', async () => {
    await vscode.commands.executeCommand('gridkitStudio.unbind', {
      uri: bench.key,
      version: (await bench.current()).version,
      origin: 'inspector',
      type: 'Bus',
      field: 'kv',
    })
    assert.deepEqual(bench.session.bindings, {})
  })

  test('lists a signal mapped from elsewhere as bound', async () => {
    await bench.results()
    await until(async () => (await bound()) === 0, 'nothing is listed as bound')
    bench.studio.bind(bench.key, VM, ['vertexColor'])
    await until(async () => (await bound()) === 1, 'the bound signal is listed')
    bench.studio.bind(bench.key, VM, [])
    await until(async () => (await bound()) === 0, 'the unbound signal is listed no longer')
  })
})
