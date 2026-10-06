/** Pixel baselines of the Network and Simulation views. They register only on Linux with
 *  SwiftShader, where the GPU and fonts are the same on every run. */

import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import pixelmatch from 'pixelmatch'
import type { Frame, Locator } from 'playwright-core'
import { PNG } from 'pngjs'
import * as vscode from 'vscode'

import { pause, type TestHost, testHost, theme, until, VIEWPORT, visible } from './harness.js'

if (process.platform === 'linux' && process.env.GRIDKIT_TEST_SOFTWARE_GPU === '1')
  suite('Visual baselines', () => {
    let bench: TestHost
    let network: Frame
    async function themed(name: string, css: string) {
      await theme(name)
      await until(
        async () => (await network.locator('body').getAttribute('class'))?.split(' ').includes(css),
        'theme applied',
      )
    }

    /** Compare `locator` with its baseline, or write the baseline when GRIDKIT_UPDATE_BASELINES
     *  is set. The actual image, and any difference, land beside the screenshots. */
    async function compare(name: string, locator: Locator) {
      await vscode.commands.executeCommand('notifications.clearAll')
      await bench.page.mouse.move(0, 0)
      await pause(600)
      assert.equal(
        await network.locator('.canvas-host__notice:not([hidden])').count(),
        0,
        'Network must have no render error',
      )
      const bytes = await locator.screenshot({ animations: 'disabled' })
      const directory = join(process.env.GRIDKIT_TEST_ROOT!, 'tests/vscode/baselines')
      const path = join(directory, name + '.png')
      await writeFile(join(bench.output, 'playwright', name + '-actual.png'), bytes)
      if (process.env.GRIDKIT_UPDATE_BASELINES === '1') {
        await mkdir(directory, { recursive: true })
        await writeFile(path, bytes)
        return
      }
      const expected = PNG.sync.read(await readFile(path))
      const actual = PNG.sync.read(bytes)
      assert.deepEqual(
        [actual.width, actual.height],
        [expected.width, expected.height],
        name + ' dimensions',
      )
      const diff = new PNG({ width: actual.width, height: actual.height })
      const changed = pixelmatch(
        expected.data,
        actual.data,
        diff.data,
        actual.width,
        actual.height,
        { threshold: 0.12 },
      )
      if (changed)
        await writeFile(join(bench.output, 'playwright', name + '-diff.png'), PNG.sync.write(diff))
      assert.ok(
        changed / (actual.width * actual.height) < 0.001,
        `${name}: ${changed} changed pixels; inspect the actual and diff images before updating baselines`,
      )
    }

    suiteSetup(async () => {
      bench = await testHost()
      await vscode.commands.executeCommand('workbench.action.closePanel')
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
      network = await bench.open('network')
      await vscode.commands.executeCommand('gridkitStudio.fit', bench.uri)
    })
    suiteTeardown(async () => {
      await theme(undefined)
      await bench.page.setViewportSize(VIEWPORT)
    })

    for (const [name, value, css] of [
      ['dark', 'Default Dark Modern', 'vscode-dark'],
      ['light', 'Default Light Modern', 'vscode-light'],
      ['high-contrast', 'Default High Contrast', 'vscode-high-contrast'],
    ] as const)
      test(`network labels, geometry and selection in ${name}`, async () => {
        await themed(value, css)
        assert.equal(bench.session.settings['network.vertices.labels'], true)
        bench.studio.select(bench.key, { id: 'Bus/1' })
        await compare('network-' + name, network.locator('canvas'))
      })

    test('mapped vertex colors give each edge the average of its ends', async () => {
      await themed('Default Dark Modern', 'vscode-dark')
      const field = { type: 'Bus', field: 'init.Vr' }
      bench.studio.bind(bench.key, field, ['vertexColor'])
      try {
        await compare('network-mapped', network.locator('canvas'))
      } finally {
        bench.studio.bind(bench.key, field, [])
      }
    })

    test('Simulation fits a narrow view', async () => {
      await theme('Default Dark Modern')
      await bench.page.setViewportSize({ width: 1000, height: 720 })
      await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
      // Collapse the sidebar's other views, so the view's size is the same on every run.
      const expanded = bench.page
        .locator('.pane-header[aria-expanded="true"]')
        .filter({ hasText: /MONITORED SIGNALS|VIDEO EXPORT/i })
      while (await expanded.count()) {
        const count = await expanded.count()
        await expanded.first().click()
        await until(async () => (await expanded.count()) < count, 'sibling view collapsed')
      }
      const simulation = await bench.view('simulation')
      await visible(simulation, '[data-testid="field-tmax"]')
      assert.equal(
        await simulation.evaluate('document.documentElement.scrollWidth <= innerWidth'),
        true,
      )
      await compare('simulation-narrow', simulation.locator('body'))
    })

    test('geographic placement keeps labels and line styling', async () => {
      await bench.page.setViewportSize(VIEWPORT)
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      const source = JSON.parse(bench.text)
      source.buses.forEach((bus: { extension?: unknown }, i: number) => {
        bus.extension = { longitude: -100 + (i % 8) * 2, latitude: 30 + Math.floor(i / 8) * 2 }
      })
      await bench.replace(JSON.stringify(source))
      await bench.settled()
      network = await bench.open('network')
      await until(
        () => network.getByRole('button', { name: 'Globe', exact: true }).isEnabled(),
        'geographic projection arrives',
      )
      await vscode.commands.executeCommand('gridkitStudio.fit', bench.uri)
      await compare('network-geographic', network.locator('canvas'))
    })
  })
