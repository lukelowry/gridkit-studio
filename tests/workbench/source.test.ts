import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { until, visible, type Workbench, workbench } from './harness.js'

suite('Case source', () => {
  let bench: Workbench
  const git = (...args: string[]) =>
    promisify(execFile)('git', ['-C', dirname(bench.uri.fsPath), ...args], { windowsHide: true })

  suiteSetup(async () => {
    bench = await workbench()
  })

  test('leaves the last valid case on show, marked, while it is invalid', async () => {
    const { document, text } = bench
    const table = await bench.show('table')
    const invalid = new vscode.WorkspaceEdit()
    invalid.insert(bench.uri, new vscode.Position(0, 0), '{')
    await vscode.workspace.applyEdit(invalid)
    await until(() => bench.studio.state(bench.key).stale, 'the invalid source is noticed')
    await visible(table, '.c-note--warn')
    await vscode.commands.executeCommand('gridkitStudio.showSource', bench.uri)
    await vscode.commands.executeCommand('gridkitStudio.stop', bench.uri)
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    await until(() => vscode.window.activeTextEditor?.document === document, 'the source in focus')
    // Undone from the keyboard, as its reader would.
    await bench.page.locator('.monaco-editor.focused').getByRole('textbox').press('ControlOrMeta+z')
    await until(() => document.getText() === text, 'the invalid edit undone')
    await bench.settled()
  })

  test('changes only the edited field, as Git sees the saved text', async () => {
    const [bus] = bench.source.buses
    await git('init', '--quiet')
    await bench.document.save()
    await git('add', '--', 'two bus.case.json')
    await git(
      '-c',
      'user.name=GridKit Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Fixture baseline',
    )
    await bench.studio.documents.edit(
      bench.key,
      (await bench.current()).version,
      { id: 'Bus/' + bus!.number, field: 'kv' },
      bus!.params.kv + 1,
    )
    await bench.settled()
    await bench.document.save()
    const diff = await git('diff', '--', 'two bus.case.json')
    assert.match(diff.stdout, /\+.*kv/)
    assert.ok(diff.stdout.length < 3000, 'A field edit should not reserialize the case')
    bench.report.gitDiffBytes = diff.stdout.length
  })

  test('reviews its changes in the native diff editor', async () => {
    await vscode.commands.executeCommand('gridkitStudio.reviewChanges', bench.uri)
    await until(
      () =>
        vscode.window.tabGroups.all.some((group) =>
          group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff),
        ),
      'the native Git text diff',
    )
    await bench.capture('git-diff')
    await bench.undo('the edit undone')
    await bench.document.save()
  })
})
