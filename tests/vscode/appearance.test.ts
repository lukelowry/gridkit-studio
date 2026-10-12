/** Appearance: high contrast, a compact window. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { type TestHost, testHost, theme, until, VIEWPORT, visible } from './harness.js'

suite('Appearance', () => {
  let bench: TestHost
  /** Video Export, the side bar's own webview. */
  let exporter: Frame
  const highContrast = async () =>
    !!(await exporter.locator('body').getAttribute('class'))?.includes('vscode-high-contrast')

  suiteSetup(async () => {
    bench = await testHost()
    await bench.results()
    exporter = await bench.show('export')
  })

  test('follows the theme into high contrast, and back', async () => {
    await theme('Default High Contrast')
    await until(highContrast, 'high contrast')
    await bench.capture('high-contrast-vscode')
    await theme(undefined)
    await until(async () => !(await highContrast()), 'the theme restored')
  })

  test('raises its contrast as the setting says, whatever the theme', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    const focusWidth = () =>
      exporter.evaluate<string>(
        `getComputedStyle(document.body).getPropertyValue('--focus-width').trim()`,
      )
    try {
      await settings.update('accessibility.contrast', 'high', vscode.ConfigurationTarget.Global)
      await until(async () => (await focusWidth()) === '3px', 'thicker focus rings')
      await settings.update('accessibility.contrast', 'system', vscode.ConfigurationTarget.Global)
      await until(async () => (await focusWidth()) === '2px', 'the theme’s own again')
    } finally {
      await settings.update('accessibility.contrast', undefined, vscode.ConfigurationTarget.Global)
    }
  })

  test('holds its views in a compact window', async () => {
    await bench.page.setViewportSize({ width: 1000, height: 720 })
    try {
      await visible(exporter, '[data-testid="video-export"]')
      // The form fits the narrow side bar: nothing scrolls sideways.
      assert.equal(
        await exporter.evaluate('document.documentElement.scrollWidth <= innerWidth'),
        true,
      )
      await bench.capture('compact-vscode')
    } finally {
      await bench.page.setViewportSize(VIEWPORT)
    }
  })
})
