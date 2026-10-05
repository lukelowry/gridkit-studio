/** Appearance: high contrast, a compact window, and the case offered to language models. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { type TestHost, testHost, theme, until, VIEWPORT, visible } from './harness.js'

suite('Appearance', () => {
  let bench: TestHost
  let simulation: Frame
  const highContrast = async () =>
    !!(await simulation.locator('body').getAttribute('class'))?.includes('vscode-high-contrast')

  suiteSetup(async () => {
    bench = await testHost()
    simulation = await bench.show('simulation')
  })

  test('follows the theme into high contrast, and back', async () => {
    await theme('Default High Contrast')
    await until(highContrast, 'high contrast')
    await bench.capture('high-contrast-vscode')
    await theme(undefined)
    await until(async () => !(await highContrast()), 'the theme restored')
  })

  test('holds its views in a compact window', async () => {
    await bench.page.setViewportSize({ width: 1280, height: 800 })
    try {
      await visible(simulation, '[data-testid="study-run"]')
      await bench.capture('compact-vscode')
    } finally {
      await bench.page.setViewportSize(VIEWPORT)
    }
  })

  test('offers the case to language models through its tools', async () => {
    const tools = vscode.lm.tools.filter((tool) => tool.name.startsWith('gridkit_'))
    assert.equal(tools.length, 10)
    const rows = await vscode.lm.invokeTool('gridkit_query_rows', {
      input: {
        uri: bench.document.uri.toString(),
        version: bench.document.version,
        from: 'Bus',
        select: ['name', 'params.kv'],
        limit: 2,
      },
      toolInvocationToken: undefined,
    })
    assert.ok(rows.content.length)
  })
})
