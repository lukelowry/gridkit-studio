import * as assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type Browser, chromium, type Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { changeJson } from '../../src/gridkit/edit.js'
import { runSimulationWorkflow } from './simulation.js'
import { runSlice } from './slice.js'
import { runSolverSlice } from './solver.js'
import { focus, until } from './wait.js'

type CaseSummary = { name: string; buses: number; branches: number }

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]
  const uri = vscode.Uri.joinPath(folder.uri, 'two bus.case.json')
  const original = await vscode.workspace.fs.readFile(uri)
  const [port] = (
    await readFile(join(process.env.GRIDKIT_TEST_PROFILE!, 'DevToolsActivePort'), 'utf8')
  ).split('\n')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const output = join(
    vscode.extensions.getExtension('lukelowery.gridkit-studio')!.extensionUri.fsPath,
    'output',
    'playwright',
  )
  await mkdir(output, { recursive: true })
  const context = browser.contexts()[0]
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  try {
    await runInBrowser(browser, uri, original, output)
    await context.tracing.stop()
  } catch (error) {
    await context.tracing.stop({ path: join(output, 'trace.zip') }).catch(console.error)
    for (const [index, page] of browser
      .contexts()
      .flatMap((context) => context.pages())
      .entries()) {
      await page
        .screenshot({ path: join(output, `failure-${index}.png`), timeout: 5000 })
        .catch(() => {})
      for (const frame of page.frames()) {
        const content = await frame
          .locator('main')
          .innerText({ timeout: 1000 })
          .catch(() => '')
        if (content) console.error('Visible content:', content)
      }
    }
    throw error
  } finally {
    await browser.close()
  }
}

async function runInBrowser(
  browser: Browser,
  uri: vscode.Uri,
  original: Uint8Array,
  output: string,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]
  for (const page of browser.contexts().flatMap((context) => context.pages()))
    page.on('pageerror', (error) => console.error('Webview page error:', error.message))
  if (process.env.GRIDKIT_TEST_SOLVER === '1') {
    const workbench = (
      await Promise.all(
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .map(async (page) => ({ page, found: await page.locator('.monaco-workbench').count() })),
      )
    ).find((result) => result.found)!.page
    await runSolverSlice(browser, workbench, output)
    await runSimulationWorkflow(browser, workbench, output)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    return
  }

  const frames = async () => {
    const found: Frame[] = []
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      for (const frame of page.frames()) {
        try {
          if (await frame.locator('#network').count()) found.push(frame)
        } catch {
          /* frame recreated */
        }
      }
    }
    return found
  }
  await vscode.commands.executeCommand('vscode.open', uri, { preview: false })
  const extension = vscode.extensions.getExtension('lukelowery.gridkit-studio')!
  await until(() => extension.isActive, Boolean)
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab!
  assert.ok(tab.input instanceof vscode.TabInputCustom)
  assert.equal(tab.input.viewType, 'gridkitStudio.network')
  assert.equal(tab.input.uri.toString(), uri.toString())
  assert.equal(vscode.window.tabGroups.all.length, 1)
  await vscode.commands.executeCommand('gridkitStudio.openCase', uri)
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, tab)
  assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, 1)
  const document = await vscode.workspace.openTextDocument(uri)
  assert.equal(document.languageId, 'json')
  console.log('PASS automatic activation and default network opening without a JSON tab or split')

  const replace = async (doc: vscode.TextDocument, text: string) => {
    const edit = new vscode.WorkspaceEdit()
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      text,
    )
    assert.equal(await vscode.workspace.applyEdit(edit), true)
  }
  const problems = (uri: vscode.Uri) =>
    vscode.languages.getDiagnostics(uri).filter((issue) => issue.source === 'GridKit')
  const changed = JSON.parse(document.getText())
  changed.header.case_name = 'Unsaved \u{1f30d} case'
  const branch = changed.devices.find((device: { class: string }) => device.class === 'Branch')
  branch.ports.bus2 = 99
  await replace(document, JSON.stringify(changed, null, 2))
  const issues = await until(
    () => problems(uri),
    (issues) => issues.length > 0,
  )
  assert.equal(document.getText(issues[0].range), '99')
  assert.deepEqual(await vscode.workspace.fs.readFile(uri), original)

  const secondUri = vscode.Uri.joinPath(folder.uri, 'SECOND.CASE.JSON')
  const geo = JSON.parse(new TextDecoder().decode(original))
  geo.buses.forEach((bus: { extension: unknown }, index: number) => {
    bus.extension = { longitude: -100 + index, latitude: 40 + index }
  })
  const geographicText = geo.buses.reduce(
    (text: string, bus: { extension: unknown }, index: number) =>
      changeJson(text, ['buses', index, 'extension'], bus.extension),
    new TextDecoder().decode(original),
  )
  await vscode.workspace.fs.writeFile(secondUri, new TextEncoder().encode(geographicText))
  const second = await vscode.workspace.openTextDocument(secondUri)
  const checked = await vscode.commands.executeCommand<CaseSummary>(
    'gridkitStudio.validateCase',
    secondUri,
  )
  assert.equal(checked.buses, 2)
  assert.equal(problems(secondUri).length, 0)
  assert.equal(problems(uri).length, 1)
  console.log('PASS live diagnostics, exact locations, and independent cases')

  let views = await until(frames, (frames) => frames.length > 0, 30000)
  const preview = views[0]
  await preview.locator('body[data-state="invalid"]').waitFor()
  await vscode.commands.executeCommand('gridkitStudio.showSource')
  assert.equal(vscode.window.activeTextEditor?.document, document)
  assert.equal(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.Two)
  await vscode.commands.executeCommand('undo')
  await until(
    () => problems(uri).length,
    (count) => count === 0,
  )
  await preview.locator('body[data-state="ready"]').waitFor({ timeout: 30000 })
  assert.equal(await preview.locator('body').getAttribute('data-version'), String(document.version))
  assert.equal(await preview.locator('main').innerText(), '')
  console.log('PASS undo clears diagnostics and restores a rendered network')

  await vscode.commands.executeCommand('notifications.clearAll')
  await preview.locator('main').screenshot({ path: join(output, 'network.png') })
  await preview.locator('#network').click()
  await new Promise((resolve) => setTimeout(resolve, 200))
  await vscode.commands.executeCommand('gridkitStudio.showSource')
  const selected = vscode.window.activeTextEditor!
  assert.match(selected.document.getText(selected.selection), /"class": "Branch"/)
  console.log('PASS renderer picking reveals the branch source')

  await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup')
  await vscode.commands.executeCommand('vscode.open', secondUri, { preview: false })
  assert.ok(
    vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom,
  )
  assert.equal(vscode.window.tabGroups.all.length, 2)
  views = await until(frames, (frames) => frames.length >= 2, 30000)
  const geographic = views.find((frame) => frame !== preview)!
  await geographic.locator('body[data-state="ready"]').waitFor({ timeout: 30000 })
  assert.equal(await geographic.locator('main').innerText(), '')
  await until(
    () =>
      geographic.evaluate(
        () =>
          performance
            .getEntriesByType('resource')
            .filter((entry) => entry.name.includes('ne-50m-line-borders')).length,
      ),
    (count) => count === 2,
  )
  await geographic.locator('main').screenshot({ path: join(output, 'geographic.png') })
  assert.equal(problems(second.uri).length, 0)
  assert.deepEqual(await vscode.workspace.fs.readFile(uri), original)
  console.log('PASS multiple previews, uppercase names, and bundled geographic assets')

  const workbench = (
    await Promise.all(
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .map(async (page) => ({ page, found: await page.locator('.monaco-workbench').count() })),
    )
  ).find((result) => result.found)!.page
  await focus(geographic.locator('#network'))
  const chooseProjection = vscode.commands.executeCommand('gridkitStudio.projection')
  await workbench.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Globe' }).click()
  await chooseProjection
  await until(
    () => geographic.locator('#network').getAttribute('aria-label'),
    (label) => !!label?.includes('globe projection'),
  )
  await vscode.window.showTextDocument(second, { viewColumn: vscode.ViewColumn.Two })
  await vscode.commands.executeCommand('gridkitStudio.preview', secondUri)
  assert.equal(vscode.window.tabGroups.all.length, 2)
  views = await until(
    frames,
    (frames) => frames.some((frame) => frame !== preview && frame !== geographic),
    30000,
  )
  const restored = views.find((frame) => frame !== preview && frame !== geographic)!
  await restored.locator('body[data-state="ready"]').waitFor({ timeout: 30000 })
  await focus(restored.locator('#network'))
  const inspectProjection = vscode.commands.executeCommand('gridkitStudio.projection')
  const globe = workbench.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Globe' })
  await globe.waitFor()
  assert.match(await globe.innerText(), /Current/)
  await globe.click()
  await inspectProjection
  await vscode.commands.executeCommand('gridkitStudio.fit')
  console.log('PASS native projection picker and restoration after hiding the preview')

  const unavailableGpu = await browser.contexts()[0].addInitScript(() => {
    const page = globalThis as unknown as { navigator: { gpu?: unknown }; __testGPU: unknown }
    Object.defineProperty(page, '__testGPU', { value: page.navigator.gpu })
    Object.defineProperty(page.navigator, 'gpu', { configurable: true, value: undefined })
  })
  await vscode.window.showTextDocument(second, { viewColumn: vscode.ViewColumn.Two })
  await vscode.commands.executeCommand('gridkitStudio.preview', secondUri)
  assert.equal(vscode.window.tabGroups.all.length, 2)
  views = await until(
    frames,
    (frames) => frames.some((frame) => frame !== preview && frame !== restored),
    30000,
  )
  const fallback = views.find((frame) => frame !== preview && frame !== restored)!
  await fallback.locator('body[data-state="error"]').waitFor({ timeout: 30000 })
  assert.match(await fallback.locator('#message').innerText(), /JSON editor/)
  await fallback.evaluate(() => {
    const page = globalThis as unknown as { navigator: unknown; __testGPU: unknown }
    Object.defineProperty(page.navigator, 'gpu', { value: page.__testGPU })
  })
  await fallback.locator('#retry').click()
  await fallback.locator('body[data-state="ready"]').waitFor({ timeout: 30000 })
  await unavailableGpu.dispose()
  console.log('PASS unavailable WebGPU leaves JSON accessible and Retry recovers rendering')

  const provider = vscode.workspace.registerTextDocumentContentProvider('gridkit-test', {
    provideTextDocumentContent: () => new TextDecoder().decode(original),
  })
  try {
    const remote = await vscode.commands.executeCommand<CaseSummary>(
      'gridkitStudio.validateCase',
      vscode.Uri.parse('gridkit-test:/remote.case.json'),
    )
    assert.equal(remote.buses, 2)
  } finally {
    provider.dispose()
  }
  console.log('PASS virtual case documents')
  await runSlice(browser, workbench, output)

  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
}
