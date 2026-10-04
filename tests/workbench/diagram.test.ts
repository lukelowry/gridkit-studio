import assert from 'node:assert/strict'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { until, type Workbench, workbench } from './harness.js'

suite('Diagram', () => {
  let bench: Workbench
  let diagram: Frame
  const editing = () => bench.session.diagramEditing

  suiteSetup(async () => {
    bench = await workbench()
    // Beside the Network: two editors on the one native document.
    diagram = await bench.open('diagram', vscode.ViewColumn.Beside)
  })
  suiteTeardown(async () => {
    if (editing())
      await vscode.commands.executeCommand('gridkitStudio.toggleDiagramEditing', bench.uri)
  })

  test('draws the case beside its Network', async () => {
    bench.report.diagram = await diagram.evaluate('gridkitStats()')
    await bench.capture('diagram-workbench')
  })

  test('enters editing from its command', async () => {
    await vscode.commands.executeCommand('gridkitStudio.toggleDiagramEditing', bench.uri)
    await until(
      async () =>
        (await diagram.locator('canvas').getAttribute('aria-label'))?.includes('Diagram editing.'),
      'diagram edit mode',
    )
    assert.ok(editing())
  })

  test('writes an arrangement into the case, which native undo takes back', async () => {
    await vscode.commands.executeCommand('gridkitStudio.arrangeDiagram', bench.uri)
    await until(
      () => bench.document.getText().includes('"diagram"'),
      'the arrangement is written into the case',
    )
    await bench.settled()
    const { devices } = JSON.parse(bench.document.getText()) as Workbench['source']
    assert.ok(devices.some((device) => device.extension?.diagram))
    await bench.capture('diagram-editing')
    await bench.undo('the arrangement undone')
  })

  test('follows a native setting while it shows', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio', bench.uri)
    await settings.update('diagram.edgeWidthPx', 3, vscode.ConfigurationTarget.Workspace)
    await until(
      () => bench.studio.current().settings['diagram.edgeWidthPx'] === 3,
      'the setting reaches the case',
    )
    await settings.update('diagram.edgeWidthPx', undefined, vscode.ConfigurationTarget.Workspace)
  })
})
