/** Appearance: high contrast, a compact window, and the case offered to language models. */

import assert from 'node:assert/strict'
import { basename } from 'node:path'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { toolDefinitions } from '../../src/shared/tools.js'
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
      await visible(simulation, '[data-testid="simulation-start"]')
      await bench.capture('compact-vscode')
    } finally {
      await bench.page.setViewportSize(VIEWPORT)
    }
  })

  test('offers the case to language models through its tools', async () => {
    const tools = vscode.lm.tools.filter((tool) => tool.name.startsWith('gridkit_'))
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      toolDefinitions.map((tool) => 'gridkit_' + tool.name).sort(),
    )
    const listed = await vscode.lm.invokeTool('gridkit_list_cases', {
      input: {},
      toolInvocationToken: undefined,
    })
    assert.match(JSON.stringify(listed.content), new RegExp(basename(bench.document.uri.fsPath)))
  })
})
