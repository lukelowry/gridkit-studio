import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium, type Frame } from 'playwright-core'
import * as vscode from 'vscode'

import type { Sessions } from '../../src/sessions.js'

export async function run() {
  const root = process.env.GRIDKIT_TEST_ROOT!
  const output = process.env.GRIDKIT_TEST_OUTPUT!
  await mkdir(join(output, 'tests'), { recursive: true })
  await mkdir(join(output, 'playwright'), { recursive: true })
  const [port] = (
    await readFile(join(process.env.GRIDKIT_TEST_PROFILE!, 'DevToolsActivePort'), 'utf8')
  ).split('\n')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const workbench = browser.contexts().flatMap((c) => c.pages())[0]!
  await workbench.setViewportSize({ width: 1600, height: 1000 })
  const results: unknown[] = []
  try {
    for (const [name, fixture] of [
      ['IEEE39', 'tests/fixtures/IEEE39.case.json'],
      ['ACTIVSg2000', 'cases/ACTIVSg2000.case.json'],
      ['ACTIVSg10k', 'cases/ACTIVSg10k.case.json'],
    ]) {
      const uri = vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders![0]!.uri,
        name + '.case.json',
      )
      await copyFile(join(root, fixture!), uri.fsPath)
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      const started = performance.now()
      await vscode.commands.executeCommand('vscode.open', uri)
      let view: Frame | undefined
      const limit = started + 60000
      while (performance.now() < limit) {
        for (const candidate of workbench.frames()) {
          if (
            await candidate
              .locator('body[data-kind="network"] canvas[data-rendered="true"]')
              .isVisible()
              .catch(() => false)
          ) {
            view = candidate
            break
          }
        }
        if (
          view &&
          (await view
            .locator('body[data-kind="network"] canvas[data-rendered="true"]')
            .isVisible()
            .catch(() => false))
        )
          break
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.ok(view, 'Network webview must open')
      await view.locator('canvas[data-rendered="true"]').waitFor({ timeout: 60000 })
      const firstFrameMs = performance.now() - started
      const metrics = await view.evaluate<Record<string, unknown>>(`(() => {
  const canvas = document.querySelector('canvas')
  const rect = canvas.getBoundingClientRect()
  return {
    marks: Object.fromEntries(performance.getEntriesByType('mark').map(e => [e.name, e.startTime])),
    resources: performance.getEntriesByType('resource').map(e => ({
      name: e.name.split('/').at(-1), start: e.startTime, duration: e.duration,
    })),
    viewport: [innerWidth, innerHeight],
    canvas: [rect.x, rect.y, rect.width, rect.height],
    bodyPadding: getComputedStyle(document.body).padding,
    status: document.querySelector('.status')?.textContent,
    stats: gridkitStats(),
  }
})()`)
      assert.equal(metrics.bodyPadding, '0px')
      assert.equal(metrics.status, undefined)
      const [x, y, width, height] = metrics.canvas as number[]
      const [viewportWidth, viewportHeight] = metrics.viewport as number[]
      assert.ok(
        Math.abs(x!) < 1 &&
          Math.abs(y!) < 1 &&
          Math.abs(width! - viewportWidth!) < 1 &&
          Math.abs(height! - viewportHeight!) < 1,
      )
      const { studio } = vscode.extensions.getExtension('lukelowery.gridkit-studio')!.exports as {
        studio: Sessions
      }
      const row = {
        name,
        firstFrameMs,
        parseMs: studio.state(uri.toString()).summary?.parseMs,
        ...metrics,
      }
      results.push(row)
      console.log('Network startup:', JSON.stringify(row))
      await vscode.commands.executeCommand('notifications.clearAll')
      await workbench.screenshot({ path: join(output, 'playwright', 'startup-' + name + '.png') })
      if (name === 'ACTIVSg10k') {
        // The first-frame optimization must preserve live native border settings.
        const settings = vscode.workspace.getConfiguration('gridkitStudio', uri)
        const stats = () => view.evaluate<{ frames: number; segments: number }>('gridkitStats()')
        const before = await stats()
        await settings.update('network.borders', false, vscode.ConfigurationTarget.Workspace)
        await view.waitForFunction('(frames) => gridkitStats().frames > frames', before.frames)
        const without = await stats()
        await settings.update('network.borders', true, vscode.ConfigurationTarget.Workspace)
        await view.waitForFunction(
          '(segments) => gridkitStats().segments > segments',
          without.segments,
        )
        await workbench.screenshot({ path: join(output, 'playwright', 'network-borders-on.png') })
        await settings.update('network.borders', false, vscode.ConfigurationTarget.Workspace)
        await view.waitForFunction(
          '(segments) => gridkitStats().segments === segments',
          without.segments,
        )
        await workbench.screenshot({ path: join(output, 'playwright', 'network-borders-off.png') })
        await settings.update('network.borders', undefined, vscode.ConfigurationTarget.Workspace)
        console.log('Native Borders setting: on/off geometry verified')
      }
    }
    await writeFile(join(output, 'tests', 'network-startup.json'), JSON.stringify(results, null, 2))
  } finally {
    await browser.close()
  }
}
