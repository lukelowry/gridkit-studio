/** The Diagram editor beside the Network: editing, arrangement through the document, settings. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame } from 'playwright-core'
import * as vscode from 'vscode'

import { stats, type TestHost, testHost, until } from './harness.js'

suite('Diagram', () => {
  let bench: TestHost
  let diagram: Frame
  const editing = () => bench.session.diagramEditing

  suiteSetup(async () => {
    bench = await testHost()
    // Beside the Network: two editors on the one native document.
    diagram = await bench.open('diagram', vscode.ViewColumn.Beside)
  })
  suiteTeardown(async () => {
    if (editing())
      await vscode.commands.executeCommand('gridkitStudio.toggleDiagramEditing', bench.uri)
  })

  test('draws the case beside its Network', async () => {
    bench.report.diagram = await stats(diagram)
    await bench.capture('diagram-vscode')
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
    const { devices } = JSON.parse(bench.document.getText()) as TestHost['source']
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

  test('keeps visibility and detailed native settings independent', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio', bench.uri)
    const values = {
      'diagram.labels.visible': false,
      'diagram.labels.maxWidth': 140,
      'monitor.xAxis.visible': false,
      'monitor.xAxis.precision': 3,
      'monitor.yAxis.visible': false,
      'monitor.yAxis.format': 'scientific',
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
})
