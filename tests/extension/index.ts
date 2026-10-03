import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

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
      for (const candidate of page.frames())
        if (
          await candidate
            .locator('body[data-kind="' + kind + '"]')
            .isVisible()
            .catch(() => false)
        )
          return candidate
  }, kind + ' webview')
}
async function visible(frame: Frame, selector: string) {
  await frame.locator(selector).first().waitFor({ state: 'visible', timeout: 30000 })
}
export async function run() {
  const extension = vscode.extensions.getExtension('lukelowery.gridkit-studio')
  assert.ok(extension, 'GridKit Studio must be installed and enabled')
  const root = vscode.workspace.workspaceFolders![0]!.uri
  const uri = vscode.Uri.joinPath(root, 'two bus.case.json')
  const started = performance.now()
  // Exercise user activation through a file open; never force extension.activate().
  await vscode.commands.executeCommand('vscode.open', uri)
  await until(() => extension.isActive, 'automatic case activation')
  const { studio } = extension.exports as { studio: Sessions }
  const report: Record<string, unknown> = {
    vscodeVersion: vscode.version,
    extensionVersion: extension.packageJSON.version,
    openCaseMs: performance.now() - started,
    latkit: extension.packageJSON.dependencies,
  }
  const document = await vscode.workspace.openTextDocument(uri)
  const text = document.getText()
  const original = JSON.parse(text)
  const [port] = (
    await readFile(join(process.env.GRIDKIT_TEST_PROFILE!, 'DevToolsActivePort'), 'utf8')
  ).split('\n')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const workbench = browser.contexts().flatMap((context) => context.pages())[0]!
  await workbench.setViewportSize({ width: 1600, height: 1000 })
  const errors: string[] = []
  workbench.on('pageerror', (error) => errors.push(error.message))
  const output = process.env.GRIDKIT_TEST_OUTPUT ?? join(extension.extensionPath, 'output')
  await mkdir(join(output, 'playwright'), { recursive: true })
  await mkdir(join(output, 'tests'), { recursive: true })
  const capture = async (name: string) => {
    await vscode.commands.executeCommand('notifications.clearAll')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await workbench.screenshot({ path: join(output, 'playwright', name + '.png') })
  }
  const current = () => studio.documents.ensure(document)
  const settled = () =>
    until(
      () =>
        studio.state(uri.toString()).summary?.version === document.version &&
        !studio.state(uri.toString()).stale,
      'document projection',
    )
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.network')
    const network = await frame(browser, 'network')
    await visible(network, 'canvas[data-rendered=true]')
    assert.equal(studio.state(uri.toString()).summary?.counts.Bus, 39)
    assert.equal(await network.locator('.toolbar').count(), 0)
    report.network = JSON.parse(
      (await network.locator('canvas').getAttribute('data-stats')) ?? '{}',
    )
    await capture('network-workbench')

    await vscode.commands.executeCommand('gridkitStudio.openTable', uri)
    let table = await frame(browser, 'table')
    await visible(table, 'tbody .cell')
    assert.equal(await table.locator('.toolbar').count(), 0)
    const panel = await workbench.locator('.part.panel').boundingBox()
    const firstCell = await table.locator('tbody .cell').first().boundingBox()
    assert.ok(
      panel && firstCell && firstCell.y >= panel.y,
      'Case table must be in the native bottom panel',
    )
    await capture('table-workbench')
    // Real native context menu, including the exact field target.
    const editable = table
      .locator('td[data-vscode-context*="gridkitEditable\\\":true"] .cell')
      .first()
    await editable.click({ button: 'right' })
    await workbench
      .getByRole('menuitem')
      .filter({ hasText: 'Edit Field' })
      .first()
      .waitFor({ state: 'visible' })
    await capture('table-native-menu')
    await workbench.keyboard.press('Escape')
    // Cell keyboard editing traverses webview -> worker -> WorkspaceEdit.
    const kv = table.locator('td[data-vscode-context*="kv"] .cell').first()
    await kv.dblclick()
    await visible(table, 'input[aria-label="Edit kv"]')
    await table.locator('input[aria-label="Edit kv"]').fill(String(original.buses[0].params.kv + 1))
    await table.locator('input[aria-label="Edit kv"]').press('Enter')
    await until(
      () =>
        document.isDirty &&
        JSON.parse(document.getText()).buses[0].params.kv === original.buses[0].params.kv + 1,
      'table native edit',
    )
    await settled()
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('undo')
    await until(() => document.getText() === text, 'native undo')
    await settled()
    await vscode.commands.executeCommand('redo')
    await until(() => document.getText() !== text, 'native redo')
    await settled()
    await vscode.commands.executeCommand('undo')
    await until(() => document.getText() === text, 'restore source')
    await settled()
    const summary = await current()
    await assert.rejects(
      studio.documents.edit(
        uri.toString(),
        summary.version - 1,
        { id: 'Bus/' + original.buses[0].number, field: 'kv' },
        1,
      ),
      /changed/,
    )

    // Multiple editor projections and layout edits share a single native document.
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'gridkitStudio.diagram',
      vscode.ViewColumn.Beside,
    )
    let diagram = await frame(browser, 'diagram')
    await visible(diagram, 'canvas[data-rendered=true]')
    report.diagram = JSON.parse(
      (await diagram.locator('canvas').getAttribute('data-stats')) ?? '{}',
    )
    await capture('diagram-workbench')
    await vscode.commands.executeCommand('gridkitStudio.toggleDiagramEditing', uri)
    await until(
      async () => (await diagram.locator('.status').innerText()).includes('Editing:'),
      'diagram edit mode',
    )
    await vscode.commands.executeCommand('gridkitStudio.arrangeDiagram', uri)
    await until(
      () => document.getText().includes('"diagram"'),
      'diagram arrangement writes case metadata',
    )
    await settled()
    assert.ok(
      JSON.parse(document.getText()).devices.some(
        (item: { extension?: { diagram?: unknown } }) => item.extension?.diagram,
      ),
    )
    await capture('diagram-editing')
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('undo')
    await until(() => document.getText() === text, 'diagram layout undo')
    await settled()
    // Native fields, not a custom settings screen, update a live renderer.
    await vscode.workspace
      .getConfiguration('gridkitStudio', uri)
      .update('diagram.edgeWidthPx', 3, vscode.ConfigurationTarget.Workspace)
    await until(
      () => studio.current().settings['diagram.edgeWidthPx'] === 3,
      'resource settings update',
    )
    await vscode.workspace
      .getConfiguration('gridkitStudio', uri)
      .update('diagram.edgeWidthPx', undefined, vscode.ConfigurationTarget.Workspace)

    // An invalid intermediate document leaves a visible, noneditable previous projection.
    await vscode.commands.executeCommand('gridkitStudio.openTable', uri)
    table = await frame(browser, 'table')
    const invalid = new vscode.WorkspaceEdit()
    invalid.insert(uri, new vscode.Position(0, 0), '{')
    await vscode.workspace.applyEdit(invalid)
    await until(() => studio.state(uri.toString()).stale, 'invalid source')
    await visible(table, '.warning')
    await vscode.commands.executeCommand('gridkitStudio.showSource', uri)
    await vscode.commands.executeCommand('gridkitStudio.stopSolver', uri)
    await vscode.commands.executeCommand('gridkitStudio.pauseTimeline', uri)
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    await until(() => vscode.window.activeTextEditor?.document === document, 'source focus')
    await workbench.locator('.monaco-editor.focused').getByRole('textbox').press('ControlOrMeta+z')
    await until(() => document.getText() === text, 'invalid source undo')
    await settled()
    // Git sees the exact saved native text; changes do not create a parallel SCM model.
    const git = (args: string[]) =>
      promisify(execFile)('git', ['-C', root.fsPath, ...args], { windowsHide: true })
    await git(['init', '--quiet'])
    await document.save()
    await git(['add', '--', 'two bus.case.json'])
    await git([
      '-c',
      'user.name=GridKit Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Fixture baseline',
    ])
    const before = await current()
    await studio.documents.edit(
      uri.toString(),
      before.version,
      { id: 'Bus/' + original.buses[0].number, field: 'kv' },
      original.buses[0].params.kv + 1,
    )
    await settled()
    await document.save()
    const diff = await git(['diff', '--', 'two bus.case.json'])
    assert.match(diff.stdout, /\+.*kv/)
    assert.ok(diff.stdout.length < 3000, 'A field edit should not reserialize the case')
    report.gitDiffBytes = diff.stdout.length
    await vscode.commands.executeCommand('gridkitStudio.reviewChanges', uri)
    await until(
      () =>
        vscode.window.tabGroups.all.some((group) =>
          group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff),
        ),
      'native Git text diff',
    )
    await capture('git-diff')
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('undo')
    await until(() => document.getText() === text, 'Git edit undo')
    await document.save()
    await settled()

    const csv = vscode.Uri.joinPath(root, 'Synthetic waveform.csv')
    const bus = original.buses[0]
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
      version: (await current()).version,
      path: csv.fsPath,
      cacheBytes: 32 << 20,
    })
    assert.equal(run.state, 'complete', run.message)
    const session = studio.all.get(uri.toString())!
    session.plots = [{ from: 'Bus', field: 'Vm', id: 'Bus/' + bus.number }]
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'gridkitStudio.diagram',
      vscode.ViewColumn.One,
    )
    diagram = await frame(browser, 'diagram')
    await visible(diagram, 'canvas[data-rendered=true]')
    await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
    let monitor = await frame(browser, 'monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    assert.equal(
      await monitor.locator('button').count(),
      0,
      'Monitor commands belong in native title actions',
    )
    const monitorBounds = await monitor.locator('canvas').boundingBox()
    const bottom = await workbench.locator('.part.panel').boundingBox()
    assert.ok(
      bottom && monitorBounds && monitorBounds.y >= bottom.y,
      'Monitor must be in the bottom panel',
    )
    report.monitor = JSON.parse(
      (await monitor.locator('canvas').getAttribute('data-stats')) ?? '{}',
    )
    await capture('monitor-workbench')
    await vscode.commands.executeCommand('gridkitStudio.seekTime', 0)
    await vscode.commands.executeCommand('gridkitStudio.toggleTimeline')
    await until(() => session.playing, 'playback')
    await vscode.commands.executeCommand('gridkitStudio.pauseTimeline')
    assert.equal(session.playing, false)
    await monitor.locator('canvas').click({ button: 'right' })
    await workbench
      .getByRole('menuitem')
      .filter({ hasText: 'Monitor Settings' })
      .first()
      .waitFor({ state: 'visible' })
    await capture('monitor-native-menu')
    await workbench.keyboard.press('Escape')
    // Hide/restore destroys a webview without losing case-owned plot state.
    await vscode.commands.executeCommand('gridkitStudio.openTable', uri)
    await visible(await frame(browser, 'table'), 'tbody .cell')
    await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
    monitor = await frame(browser, 'monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
    const simulation = await frame(browser, 'simulation')
    await visible(simulation, '#tmax')
    assert.equal(await simulation.locator('button').count(), 0)
    await capture('simulation-workbench')
    await vscode.workspace
      .getConfiguration()
      .update('workbench.colorTheme', 'Default High Contrast', vscode.ConfigurationTarget.Global)
    await until(
      async () =>
        (await simulation.locator('body').getAttribute('class'))?.includes('vscode-high-contrast'),
      'high contrast',
    )
    await capture('high-contrast-workbench')
    await vscode.workspace
      .getConfiguration()
      .update('workbench.colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global)
    await until(
      async () =>
        !(await simulation.locator('body').getAttribute('class'))?.includes('vscode-high-contrast'),
      'restore theme',
    )
    await workbench.setViewportSize({ width: 1280, height: 800 })
    await capture('compact-workbench')
    const tools = vscode.lm.tools.filter((tool) => tool.name.startsWith('gridkit_'))
    assert.equal(tools.length, 4)
    const ai = await vscode.lm.invokeTool('gridkit_query_rows', {
      input: { from: 'Bus', select: ['name', 'kv'], limit: 2 },
      toolInvocationToken: undefined,
    })
    assert.ok(ai.content.length)
    report.worker = await studio.client.call('stats', {})
    report.browserErrors = errors
    assert.deepEqual(errors, [])
    await writeFile(
      join(
        output,
        'tests',
        process.env.GRIDKIT_TEST_PACKAGED ? 'packaged-host-report.json' : 'host-report.json',
      ),
      JSON.stringify(report, null, 2),
    )
    console.log('Native workbench, document, Git and renderer integration passed', report)
  } catch (error) {
    await workbench.screenshot({ path: join(output, 'playwright/failure.png') }).catch(() => {})
    for (const page of browser.contexts().flatMap((context) => context.pages()))
      for (const frame of page.frames()) {
        const text = await frame
          .locator('main')
          .innerText({ timeout: 300 })
          .catch(() => '')
        if (text) console.log(text.slice(0, 1200))
      }
    throw error
  } finally {
    await browser.close()
  }
}
