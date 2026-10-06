/** The case's JSON source: invalid edits, minimal Git diffs, native review, parse errors. */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { type TestHost, testHost, until, visible } from './harness.js'

suite('Case source', () => {
  let bench: TestHost
  const git = (...args: string[]) =>
    promisify(execFile)('git', ['-C', dirname(bench.uri.fsPath), ...args], { windowsHide: true })

  suiteSetup(async () => {
    bench = await testHost()
  })

  test('leaves the last valid case on show while it is invalid, and Problems says why', async () => {
    const { document, text } = bench
    const table = await bench.show('case')
    // Establish the frame this test expects to retain, even when this suite runs alone.
    await visible(table, 'tbody .cell')
    const invalid = new vscode.WorkspaceEdit()
    invalid.insert(bench.uri, new vscode.Position(0, 0), '{')
    await vscode.workspace.applyEdit(invalid)
    await until(() => bench.studio.state(bench.key).stale, 'the invalid source is noticed')
    await until(() => vscode.languages.getDiagnostics(bench.uri).length > 0, 'Problems lists why')
    // The rows stay, and nothing in the panel speaks of the problem.
    await visible(table, 'tbody .cell')
    assert.equal(await table.locator('.c-note').count(), 0)
    await vscode.commands.executeCommand('gridkitStudio.showSource', bench.uri)
    await vscode.commands.executeCommand('gridkitStudio.stopSimulation', bench.uri)
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    await until(() => vscode.window.activeTextEditor?.document === document, 'the source in focus')
    // Undone from the keyboard, as the user would.
    await bench.page.locator('.monaco-editor.focused').getByRole('textbox').press('ControlOrMeta+z')
    await until(() => document.getText() === text, 'the invalid edit undone')
    await bench.settled()
  })

  test('changes only the edited field, as Git sees the saved text', async () => {
    const [bus] = bench.source.buses
    await git('init', '--quiet')
    await bench.document.save()
    await git('add', '--', 'IEEE39.case.json')
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
      { id: 'Bus/' + bus!.number, field: 'params.kv' },
      bus!.params.kv + 1,
    )
    await bench.settled()
    await bench.document.save()
    const diff = await git('diff', '--', 'IEEE39.case.json')
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

  test('lists why an unreadable case cannot draw in Problems alone, and draws once repaired', async () => {
    const uri = vscode.Uri.joinPath(bench.uri, '..', 'invalid.case.json')
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('{'))
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.network')
    const network = await bench.view('network')
    await until(() => bench.studio.state(uri.toString()).error, 'the parse error noticed')
    assert.ok(vscode.languages.getDiagnostics(uri).length > 0, 'Problems lists why')
    // The view stops waiting, and says nothing of the problem.
    await until(
      async () => !(await network.locator('.canvas-host__fallback').isVisible()),
      'the view stops waiting',
    )
    assert.equal(await network.locator('main').innerText(), '')
    const document = await vscode.workspace.openTextDocument(uri)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), bench.text)
    await vscode.workspace.applyEdit(edit)
    await visible(network, 'canvas[data-rendered=true]')
    await until(() => !bench.studio.state(uri.toString()).error, 'the parse error clears')
    await document.save()
    await bench.open('network')
  })
})
