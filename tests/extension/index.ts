import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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
  const [port] = (
    await readFile(join(process.env.GRIDKIT_TEST_PROFILE!, 'DevToolsActivePort'), 'utf8')
  ).split('\n')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const workbench = browser.contexts().flatMap((context) => context.pages())[0]!
  await workbench.setViewportSize({ width: 1600, height: 1000 })
  // Playwright follows the frames it sees attach, so the editor opens again now that it watches.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.network')
  const document = await vscode.workspace.openTextDocument(uri)
  const text = document.getText()
  const original = JSON.parse(text)
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
    // The canvas's own controls: three projections, of which one shows, rotation, and fit.
    await visible(network, '[data-testid="view-toolbar"]')
    assert.equal(await network.locator('.toolbar button').count(), 5)
    await until(
      async () => (await network.locator('.toolbar button[aria-pressed="true"]').count()) === 1,
      'the projection on show is pressed',
    )
    assert.equal(await network.locator('.status').count(), 0)
    const bounds = await network.evaluate<string>(
      "JSON.stringify((() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.x, r.y, r.width - innerWidth, r.height - innerHeight] })())",
    )
    assert.ok(
      JSON.parse(bounds).every((n: number) => Math.abs(n) < 1),
      'Network must fill its editor',
    )
    assert.equal(
      extension.packageJSON.contributes.customEditors.find(
        (entry: { viewType: string }) => entry.viewType === 'gridkitStudio.network',
      ).displayName,
      'Network',
    )
    report.network = await network.evaluate('gridkitStats()')
    // Marked, so that the view shown again later can be told from one built again.
    await network.evaluate('window.gridkitKept = true')
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
    report.diagram = await diagram.evaluate('gridkitStats()')
    await capture('diagram-workbench')
    await vscode.commands.executeCommand('gridkitStudio.toggleDiagramEditing', uri)
    await until(
      async () =>
        (await diagram.locator('canvas').getAttribute('aria-label'))?.includes('Diagram editing.'),
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
    await visible(table, '.c-note--warn')
    await vscode.commands.executeCommand('gridkitStudio.showSource', uri)
    await vscode.commands.executeCommand('gridkitStudio.stop', uri)
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
      // Every bus's voltage, each a little out of step with the last.
      new TextEncoder().encode(
        ['time', ...original.buses.map((each: { name: string }) => 'Bus_' + each.name + '_Vm')] +
          '\n' +
          Array.from(
            { length: 100 },
            (_, i) =>
              [
                i / 100,
                ...original.buses.map((_: unknown, k: number) => 1 + 0.1 * Math.sin(i / 10 + k)),
              ] + '\n',
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
    // Playback is the Monitor's own: its controls change the case's one clock.
    await visible(monitor, '[data-testid="transport"]')
    await visible(monitor, '[data-testid="monitor-signal"]')
    assert.match((await monitor.locator('.lane__name').first().textContent()) ?? '', /Bus · /)
    const monitorBounds = await monitor.locator('canvas').boundingBox()
    const bottom = await workbench.locator('.part.panel').boundingBox()
    assert.ok(
      bottom && monitorBounds && monitorBounds.y >= bottom.y,
      'Monitor must be in the bottom panel',
    )
    await capture('monitor-workbench')
    const clock = () => session.transport.state
    assert.equal(clock().status, 'paused')
    await vscode.commands.executeCommand('gridkitStudio.seekTime', 0.5)
    assert.equal(session.transport.currentT(), 0.5)
    await until(
      async () =>
        (await monitor.locator('[data-testid="transport-time"]').textContent())?.includes('0.50'),
      'the playhead reaches the view',
    )
    await monitor.locator('[data-testid="transport-play"]').click()
    await until(() => clock().status === 'playing', 'playback from the view')
    await vscode.commands.executeCommand('gridkitStudio.toggleTimeline')
    assert.equal(clock().status, 'paused')
    await monitor.locator('[data-testid="transport-loop"]').click()
    await until(() => clock().loop === 'wrap', 'repeat from the view')
    const paused = session.transport.currentT()
    await monitor.locator('[data-testid="transport-step-forward"]').click()
    await until(() => session.transport.currentT() > paused, 'frame step from the view')
    await monitor.locator('canvas').click({ button: 'right' })
    await workbench
      .getByRole('menuitem')
      .filter({ hasText: 'Monitor Settings' })
      .first()
      .waitFor({ state: 'visible' })
    await capture('monitor-native-menu')
    await workbench.keyboard.press('Escape')
    // Hidden behind another panel and shown again, the Monitor keeps its plots.
    await vscode.commands.executeCommand('gridkitStudio.openTable', uri)
    await visible(await frame(browser, 'table'), 'tbody .cell')
    await vscode.commands.executeCommand('gridkitStudio.openMonitor', uri)
    monitor = await frame(browser, 'monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    // Mappings stage a field's channels and apply them at once.
    await vscode.commands.executeCommand('gridkitStudio.bindings.focus')
    const mappings = await frame(browser, 'bindings')
    await mappings.locator('[data-testid="bindings-link-Bus-column-kv"]').click()
    await visible(mappings, '[data-testid="binding-editor"]')
    assert.deepEqual(session.bindings, {})
    await mappings.locator('[data-testid="binding-vertexColor"]').check()
    await mappings.locator('[data-testid="binding-apply"]').click()
    await until(() => session.bindings.vertexColor?.field === 'kv', 'mapping applied')
    assert.equal(await mappings.locator('[data-testid="binding-editor"]').count(), 0)
    await capture('mappings-workbench')
    await vscode.commands.executeCommand('gridkitStudio.unbind', {
      uri: uri.toString(),
      version: (await current()).version,
      origin: 'inspector',
      type: 'Bus',
      field: 'kv',
    })
    assert.deepEqual(session.bindings, {})

    // A mapped signal colors the network from the run, at the playhead every view shares: the
    // network draws frame after frame while the clock plays, with no word from the extension.
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'gridkitStudio.network',
      vscode.ViewColumn.One,
    )
    const colored = await frame(browser, 'network')
    await visible(colored, 'canvas[data-rendered=true]')
    assert.equal(
      await colored.evaluate('window.gridkitKept'),
      true,
      'A hidden canvas keeps its webview',
    )
    studio.bind(uri.toString(), { type: 'Bus', field: 'Vm' }, ['vertexColor'])
    await until(
      async () => (await mappings.locator('.bindings__field--bound').count()) === 1,
      'the bound signal is listed',
    )
    const drawn = () => colored.evaluate<number>('gridkitStats().frames')
    session.transport.seek(0)
    const still = await drawn()
    session.transport.play()
    await until(async () => (await drawn()) > still + 10, 'the network paints the playhead')
    session.transport.pause()
    assert.equal(await colored.locator('.canvas-host__fault:not([hidden])').count(), 0)
    await capture('network-mapped-signal')
    // Hidden behind another editor, the canvas stands still while the clock plays on.
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'gridkitStudio.diagram',
      vscode.ViewColumn.One,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const hidden = await drawn()
    session.transport.play()
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(session.transport.state.status, 'playing')
    assert.equal(await drawn(), hidden, 'A hidden canvas draws nothing')
    session.transport.pause()
    studio.bind(uri.toString(), { type: 'Bus', field: 'Vm' }, [])

    // A video of the run is written to the file the reader picks, as it is made.
    const video = vscode.Uri.joinPath(root, 'two bus.webm')
    await vscode.workspace
      .getConfiguration()
      .update('files.simpleDialog.enable', true, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand('gridkitStudio.exportVideo', uri)
    const exporter = await frame(browser, 'export')
    await visible(exporter, '[data-testid="video-export"]')
    await exporter.getByRole('switch', { name: 'Monitor' }).click()
    await exporter.locator('[data-testid="video-format"]').click()
    await exporter.locator('[role="option"][data-value="webm"]').click()
    await exporter.locator('[data-testid="video-resolution"]').click()
    await exporter.locator('[role="option"][data-value="720"]').click()
    await exporter.locator('[data-testid="video-start"]').click()
    const dialog = workbench.locator('.quick-input-widget input')
    await dialog.waitFor({ state: 'visible' })
    await dialog.fill(video.fsPath)
    await dialog.press('Enter')
    await exporter.locator('[data-testid="video-done"]').waitFor({ timeout: 120000 })
    report.videoBytes = (await stat(video.fsPath)).size
    assert.ok((report.videoBytes as number) > 1000, 'The exported video has frames')
    await capture('export-workbench')
    await vscode.workspace
      .getConfiguration()
      .update('files.simpleDialog.enable', undefined, vscode.ConfigurationTarget.Global)

    await vscode.commands.executeCommand('gridkitStudio.simulation.focus')
    const simulation = await frame(browser, 'simulation')
    // The Study panel: typed fields, its own Run, a bus picked from a list, and what to record.
    await visible(simulation, '[data-testid="field-tmax"]')
    await visible(simulation, '[data-testid="study-run"]')
    await simulation.locator('[data-testid="field-fault"]').click()
    await simulation.locator('[data-testid="field-fault_bus"]').click()
    await simulation.locator('[role="option"]').nth(2).click()
    await until(
      () => /^Bus\//.test(String(session.values.fault_bus ?? '')),
      'a fault bus picked from the list',
    )
    await simulation.locator('[data-testid="field-fault"]').click()
    await until(() => session.values.fault === false, 'the fault switched off')
    const recorded = () =>
      session.outputs.some((output) => output.from === 'Bus' && output.select.includes('Va'))
    assert.ok(recorded())
    await simulation.getByRole('button', { name: 'Monitors' }).click()
    await simulation.locator('[data-testid="monitor-class-Bus"]').click()
    await simulation.locator('[data-testid="monitor-Bus-Va"]').click()
    await until(() => !recorded(), 'a signal no longer recorded')
    await simulation.locator('[data-testid="monitor-Bus-Va"]').click()
    await until(recorded, 'the signal recorded again')
    assert.equal(await simulation.locator('#output_format').count(), 0)
    assert.equal(await simulation.getByText('Results format', { exact: true }).count(), 0)
    assert.equal(
      extension.packageJSON.contributes.views['gridkitStudio'].find(
        (entry: { id: string }) => entry.id === 'gridkitStudio.simulation',
      ).name,
      'DynamicSimulation',
    )
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
    if (process.env.GRIDKIT_TEST_LIVE) {
      // A live run through the views: frames are appended as they arrive, the playhead follows
      // the head, and the finished run scrubs from what each view holds.
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'gridkitStudio.network',
        vscode.ViewColumn.One,
      )
      const live = await frame(browser, 'network')
      await visible(live, 'canvas[data-rendered=true]')
      studio.bind(uri.toString(), { type: 'Bus', field: 'Vm' }, ['vertexColor', 'vertexHeight'])
      const imported = session.run?.id
      const painted = () => live.evaluate<number>('gridkitStats().frames')
      const before = await painted()
      await vscode.commands.executeCommand('gridkitStudio.run', uri)
      await until(
        () => session.run && session.run.id !== imported && session.run.frames > 0,
        'frames arrive',
        180000,
      )
      const followed = session.run!.state !== 'running' || session.transport.state.follow
      await until(() => session.run?.state !== 'running', 'the run ends', 300000)
      assert.equal(session.run?.state, 'complete', session.run?.message)
      assert.ok(followed, 'The playhead follows a run as it arrives')
      const [, end] = session.run!.domain
      assert.equal(session.transport.state.follow, false)
      assert.equal(session.transport.currentT(), end)
      // The task's terminal took the panel while it ran; the finished run shows the Monitor again.
      const lanes = await frame(browser, 'monitor')
      await visible(lanes, 'canvas[data-rendered=true]')
      await until(
        async () =>
          (await lanes.locator('[data-testid="transport-time"]').textContent())
            ?.replace(/\s+/g, ' ')
            .includes(end.toFixed(2) + ' /'),
        'the Monitor rests at the end of the run',
      )
      const arrived = (await painted()) - before
      // The finished run scrubs: a seek repaints the network from the samples it holds.
      const rested = await painted()
      session.transport.seek(end / 2)
      await until(async () => (await painted()) > rested, 'a seek repaints the network')
      assert.equal(await lanes.locator('.c-note--error').count(), 0)
      assert.equal(await live.locator('.canvas-host__fault:not([hidden])').count(), 0)
      report.live = { frames: session.run!.frames, domain: session.run!.domain, arrived }
      await capture('live-run')
      studio.bind(uri.toString(), { type: 'Bus', field: 'Vm' }, [])
    }
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
