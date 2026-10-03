import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type Browser, chromium, type Frame } from 'playwright-core'
import * as vscode from 'vscode'

import type { Sessions } from '../../src/sessions.js'
async function until<T>(
  get: () => Promise<T> | T,
  label: string,
  timeout = 30000,
): Promise<NonNullable<T>> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await get()
    if (value) return value as NonNullable<T>
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out: ' + label)
}
async function frame(browser: Browser, kind: string) {
  return until(async () => {
    for (const page of browser.contexts().flatMap((context) => context.pages()))
      for (const frame of page.frames()) {
        if (
          await frame
            .locator('body[data-kind="' + kind + '"]')
            .count()
            .catch(() => 0)
        )
          return frame
      }
  }, kind + ' webview')
}
async function visible(frame: Frame, selector: string) {
  await frame.locator(selector).first().waitFor({ state: 'visible', timeout: 30000 })
}
export async function run() {
  const extension = vscode.extensions.getExtension('lukelowery.gridkit-studio')!
  const start = performance.now()
  const { studio } = (await extension.activate()) as { studio: Sessions }
  const activationMs = performance.now() - start
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'two bus.case.json')
  const document = await vscode.workspace.openTextDocument(uri)
  const text = document.getText()
  const [port] = (
    await readFile(join(process.env.GRIDKIT_TEST_PROFILE!, 'DevToolsActivePort'), 'utf8')
  ).split('\n')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const errors: string[] = []
  for (const page of browser.contexts().flatMap((context) => context.pages()))
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const report: Record<string, unknown> = {
    activationMs,
    latkit: extension.packageJSON.dependencies,
  }
  const workbench = browser.contexts().flatMap((context) => context.pages())[0]!
  await workbench.setViewportSize({ width: 1600, height: 1000 })
  const capture = async (name: string) => {
    await vscode.commands.executeCommand('notifications.clearAll')
    await new Promise((resolve) => setTimeout(resolve, 350))
    await workbench.screenshot({ path: join(output, 'playwright', name + '.png') })
  }
  const output = process.env.GRIDKIT_TEST_OUTPUT ?? join(extension.extensionPath, 'output')
  await vscode.commands.executeCommand('notifications.clearAll')
  await mkdir(join(output, 'playwright'), { recursive: true })
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.tableEditor')
    const table = await frame(browser, 'table')
    await visible(table, 'tbody .cell')
    assert.equal(studio.state(uri.toString()).summary?.counts.Bus, 39)
    await capture('table-workbench')
    const nativeActions = [
      'gridkitStudio.preview',
      'gridkitStudio.openDiagram',
      'gridkitStudio.openTable',
    ].map(
      (command) =>
        extension.packageJSON.contributes.commands.find(
          (item: { command: string }) => item.command === command,
        ).title as string,
    )
    await workbench
      .locator('.explorer-viewlet .monaco-list-row')
      .filter({ hasText: 'two bus.case.json' })
      .first()
      .click({ button: 'right' })
    for (const title of nativeActions)
      await workbench
        .getByRole('menuitem')
        .filter({ hasText: title })
        .first()
        .waitFor({ state: 'visible' })
    await capture('explorer-menu')
    await workbench.keyboard.press('Escape')
    const first = studio.state(uri.toString()).summary!
    const at = performance.now()
    await studio.client.call('query', {
      uri: uri.toString(),
      version: first.version,
      query: { kind: 'rows', from: 'Bus', select: ['name', 'kv'], limit: 100, ids: true },
    })
    report.visibleRowsMs = performance.now() - at
    const original = JSON.parse(text).buses[0].params.kv
    const id = 'Bus/' + JSON.parse(text).buses[0].number
    await studio.documents.edit(uri.toString(), document.version, { id, field: 'kv' }, original + 1)
    assert.ok(document.isDirty)
    await until(
      () => studio.state(uri.toString()).summary?.version === document.version,
      'edited revision',
    )
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('editor.action.showContextMenu')
    for (const title of nativeActions)
      await workbench
        .getByRole('menuitem')
        .filter({ hasText: title })
        .first()
        .waitFor({ state: 'visible' })
    await capture('source-menu')
    await workbench.keyboard.press('Escape')
    report.nativeMenuActions = 6
    await vscode.commands.executeCommand('undo')
    await until(() => document.getText() === text, 'native undo')
    await studio.documents.ensure(document)
    const stale = document.version - 1
    await assert.rejects(
      studio.documents.edit(uri.toString(), stale, { id, field: 'kv' }, original + 2),
      /changed/,
    )
    await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.network')
    const network = await frame(browser, 'network')
    await visible(network, 'canvas')
    await visible(network, 'canvas[data-rendered=true]')
    await vscode.commands.executeCommand('notifications.clearAll')
    await capture('network-workbench')
    report.network = JSON.parse(
      (await network.locator('canvas').getAttribute('data-stats')) ?? '{}',
    )
    await network.locator('canvas').screenshot({ path: join(output, 'playwright/network.png') })
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'gridkitStudio.diagram',
      vscode.ViewColumn.Beside,
    )
    const diagram = await frame(browser, 'diagram')
    await visible(diagram, 'canvas')
    await visible(diagram, 'canvas[data-rendered=true]')
    await vscode.commands.executeCommand('notifications.clearAll')
    await capture('diagram-workbench')
    report.diagram = JSON.parse(
      (await diagram.locator('canvas').getAttribute('data-stats')) ?? '{}',
    )
    await diagram.locator('canvas').screenshot({ path: join(output, 'playwright/diagram.png') })
    studio.select(uri.toString(), {
      id:
        'Genrou/' +
        JSON.parse(text).devices.find((d: { class: string }) => d.class === 'Genrou')?.id,
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await vscode.commands.executeCommand('gridkitStudio.neighborhood')
    await capture('diagram-neighborhood')
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.tableEditor')
    await visible(await frame(browser, 'table'), 'tbody .cell')
    const restored = await frame(browser, 'table')
    const machine =
      'Genrou/' + JSON.parse(text).devices.find((d: { class: string }) => d.class === 'Genrou').id
    studio.select(uri.toString(), { id: machine })
    await until(
      async () => (await restored.locator('select').first().inputValue()) === 'Genrou',
      'linked table type',
    )
    studio.select(uri.toString(), { id })
    await until(
      async () => (await restored.locator('select').first().inputValue()) === 'Bus',
      'linked bus table',
    )
    const current = studio.state(uri.toString()).summary!
    const invalid = new vscode.WorkspaceEdit()
    invalid.insert(uri, new vscode.Position(0, 0), '{')
    await vscode.workspace.applyEdit(invalid)
    await until(() => studio.state(uri.toString()).stale, 'stale state')
    await until(async () => await restored.locator('.warning').isVisible(), 'stale view banner')
    assert.equal(studio.state(uri.toString()).summary!.fingerprint, current.fingerprint)
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('undo')
    await studio.documents.ensure(document)
    await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.tableEditor')
    const summary = studio.state(uri.toString()).summary!
    const csv = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'sample.csv')
    const bus = JSON.parse(text).buses[0]
    await vscode.workspace.fs.writeFile(
      csv,
      new TextEncoder().encode(
        'time,Bus_' +
          bus.name +
          '_Vm\n' +
          Array.from(
            { length: 100 },
            (_, i) => i / 100 + ',' + (1 + 0.1 * Math.sin(i / 10)) + '\n',
          ).join(''),
      ),
    )
    const run = await studio.client.call('import', {
      uri: uri.toString(),
      version: summary.version,
      path: csv.fsPath,
      cacheBytes: 32 << 20,
    })
    assert.equal(run.state, 'complete', run.message)
    const session = studio.current()
    session.plots = [{ from: 'Bus', field: 'Vm', id: 'Bus/' + bus.number }]
    await vscode.commands.executeCommand('gridkitStudio.openMonitor')
    const monitor = await frame(browser, 'monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    await vscode.commands.executeCommand('notifications.clearAll')
    await capture('monitor-workbench')
    report.monitor = JSON.parse(
      (await monitor.locator('canvas').getAttribute('data-stats')) ?? '{}',
    )
    await monitor.locator('canvas').screenshot({ path: join(output, 'playwright/monitor.png') })
    await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
    const simulation = await frame(browser, 'simulation')
    await visible(simulation, 'button.primary')
    await capture('simulation-workbench')
    await vscode.workspace
      .getConfiguration()
      .update('workbench.colorTheme', 'Default High Contrast', vscode.ConfigurationTarget.Global)
    await until(
      async () =>
        await simulation
          .locator('body')
          .getAttribute('class')
          .then((value) => value?.includes('vscode-high-contrast')),
      'high contrast theme',
    )
    await capture('high-contrast-workbench')
    await vscode.commands.executeCommand('gridkitStudio.seekTime', 0)
    await monitor.locator('[data-command=toggleTimeline]').click()
    await until(
      async () =>
        (await monitor.locator('[data-command=toggleTimeline]').textContent()) === 'Pause',
      'playing state',
    )
    await monitor.locator('[data-command=toggleTimeline]').click()
    await until(
      async () => (await monitor.locator('[data-command=toggleTimeline]').textContent()) === 'Play',
      'paused state',
    )
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'gridkitStudio.network',
      vscode.ViewColumn.One,
    )
    const contrastNetwork = await frame(browser, 'network')
    await visible(contrastNetwork, 'canvas[data-rendered=true]')
    await capture('high-contrast-network')
    const tools = vscode.lm.tools.filter((tool) => tool.name.startsWith('gridkit_'))
    assert.equal(tools.length, 4)
    const query = await vscode.lm.invokeTool('gridkit_query_rows', {
      input: { from: 'Bus', select: ['name', 'kv'], limit: 2 },
      toolInvocationToken: undefined,
    })
    assert.ok(query.content.length)
    const stats = await studio.client.call('stats', {})
    assert.ok(stats.cacheBytes <= 256 << 20)
    report.worker = stats
    report.browserErrors = errors
    assert.deepEqual(errors, [])
    await writeFile(
      join(
        output,
        process.env.GRIDKIT_TEST_PACKAGED
          ? 'tests/packaged-host-report.json'
          : 'tests/host-report.json',
      ),
      JSON.stringify(report, null, 2),
    )
    console.log('Native editor and renderer tests passed', report)
  } catch (error) {
    for (const [i, page] of browser
      .contexts()
      .flatMap((context) => context.pages())
      .entries()) {
      await page.screenshot({ path: join(output, `playwright/failure-${i}.png`) }).catch(() => {})
      for (const frame of page.frames()) {
        const text = await frame
          .locator('main')
          .innerText({ timeout: 500 })
          .catch(() => '')
        if (text) console.log(text.slice(0, 1500))
      }
    }
    throw error
  } finally {
    await browser.close()
  }
}
