/** The Diagram editor beside the Network: editing, arrangement through the document, settings. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { idle, stats, type TestHost, testHost, until } from './harness.js'

suite('Diagram', () => {
  let bench: TestHost
  let diagram: Frame
  const editing = () => bench.session.diagramEditing
  /** The titles the Diagram's title bar offers now. */
  const offered = () =>
    bench.menus
      .offered('editor/title', {
        ...bench.keys(),
        activeCustomEditorId: 'gridkitStudio.diagram',
      })
      .map(({ title }) => title)

  suiteSetup(async () => {
    bench = await testHost()
    // Beside the Network: two editors on the one native document.
    diagram = await bench.open('diagram', vscode.ViewColumn.Beside)
  })
  suiteTeardown(async () => {
    if (editing())
      await vscode.commands.executeCommand('gridkitStudio.finishDiagramEditing', bench.uri)
  })

  test('draws the case beside its Network', async () => {
    const drawn = await stats(diagram)
    assert.ok(drawn.frames > 0, 'the Diagram drew')
    assert.ok(await bench.view('network'), 'the Network stays open beside it')
    bench.report.diagram = drawn
    await bench.capture('diagram-vscode')
  })

  test('enters editing from its title bar, which then offers to finish instead', async () => {
    await diagram.locator('canvas').focus()
    await until(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
      return input instanceof vscode.TabInputCustom && input.viewType === 'gridkitStudio.diagram'
    }, 'the Diagram owns the editor title bar')
    await bench.title('editor', 'Edit Diagram')
    await until(
      async () =>
        (await diagram.locator('canvas').getAttribute('aria-label'))?.includes('Diagram editing.'),
      'diagram edit mode',
    )
    assert.ok(editing())
    await until(
      () => offered().includes('Finish Diagram Editing'),
      'the title bar offers to finish',
    )
    assert.ok(!offered().includes('Edit Diagram'), 'the title bar shows the Diagram edits')
  })

  test('writes an arrangement into the case, which native undo takes back', async () => {
    await vscode.commands.executeCommand('gridkitStudio.arrangeDiagram', bench.uri)
    await until(
      () => bench.document.getText().includes('"diagram"'),
      'the arrangement is written into the case',
    )
    await bench.settled()
    const { devices } = JSON.parse(bench.document.getText()) as TestHost['source']
    assert.ok(devices.some((device) => device.extension?.diagram))
    await bench.capture('diagram-editing')
    await bench.undo('the arrangement undone')
  })

  test('follows a native setting while it shows', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio', bench.uri)
    await settings.update('diagram.gap', 3, vscode.ConfigurationTarget.Workspace)
    await until(
      () => bench.studio.current().settings['diagram.gap'] === 3,
      'the setting reaches the case',
    )
    await settings.update('diagram.gap', undefined, vscode.ConfigurationTarget.Workspace)
  })

  test('commits a native block drag once, with source undo and redo', async () => {
    diagram = await bench.open('diagram')
    await bench.title('editor', 'Fit All')
    await idle(diagram)
    const block = (bench.source.devices as Array<{ class: string; id: string }>).find(
      (device) => device.class === 'Ieeest',
    )!
    const entity = { table: 'Ieeest', id: block.id }
    const point = await diagram.evaluate<[number, number]>(
      `gridkitLocate(${JSON.stringify(entity)})`,
    )
    const box = await diagram.locator('canvas').boundingBox()
    assert.ok(box && point)
    const before = bench.document.getText()
    await bench.page.mouse.move(box.x + point[0], box.y + point[1])
    await bench.page.mouse.down()
    await bench.page.mouse.move(box.x + point[0] + 45, box.y + point[1] + 25, { steps: 12 })
    await bench.page.mouse.up()
    await until(() => bench.document.getText() !== before, 'the native drag commits positions')
    await bench.settled()
    const moved = bench.document.getText()
    assert.ok(
      JSON.parse(moved).devices.find((device: { id: string }) => device.id === block.id).extension
        .diagram,
    )
    await vscode.window.showTextDocument(bench.document)
    await vscode.commands.executeCommand('undo')
    await until(() => bench.document.getText() === before, 'one source undo removes the whole drag')
    await vscode.commands.executeCommand('redo')
    await until(() => bench.document.getText() === moved, 'source redo restores the whole drag')
    await vscode.commands.executeCommand('undo')
    await until(() => bench.document.getText() === before, 'the source is restored')
    await bench.settled()
  })

  test('keeps visibility and detailed native settings independent', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio', bench.uri)
    const values = {
      'diagram.labels': false,
      'diagram.rankGap': 140,
      'diagram.direction': 'down',
      'monitor.lineWidth': 3,
      'monitor.motion': 'reduced',
      'monitor.interpolation': 'step',
    } as const
    const keys = Object.keys(values) as (keyof typeof values)[]
    try {
      for (const key of keys)
        await settings.update(key, values[key], vscode.ConfigurationTarget.Workspace)
      await until(
        () => keys.every((key) => bench.studio.current().settings[key] === values[key]),
        'visibility and detail settings reach the case together',
      )
      const actual = vscode.workspace.getConfiguration('gridkitStudio', bench.uri)
      for (const key of keys) assert.equal(actual.get(key), values[key], key)
    } finally {
      for (const key of keys)
        await settings.update(key, undefined, vscode.ConfigurationTarget.Workspace)
    }
  })

  test('finishes editing from its title bar', async () => {
    // Undo brought the case's text to the front.
    await bench.open('diagram', vscode.ViewColumn.Beside)
    await bench.title('editor', 'Finish Diagram Editing')
    await until(() => !editing(), 'editing finished')
    await until(() => offered().includes('Edit Diagram'), 'the title bar offers to edit again')
  })
})
