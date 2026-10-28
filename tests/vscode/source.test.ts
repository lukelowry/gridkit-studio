/** The case's JSON source: invalid edits, minimal Git diffs, native review, parse errors, and the
 *  catalog of GridKit's classes it is read with. */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { catalogFile } from '../../src/extension/catalog.js'
import { catalog } from '../../src/gridkit/index.js'
import { folder, type TestHost, testHost, until, visible } from './harness.js'

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
    // Whatever comes of what follows, the source is left as found, so no test after this one reads
    // the edit.
    try {
      await until(() => bench.studio.state(bench.key).stale, 'the invalid source is noticed')
      await until(() => vscode.languages.getDiagnostics(bench.uri).length > 0, 'Problems lists why')
      // The rows stay, and nothing in the panel speaks of the problem.
      await visible(table, 'tbody .cell')
      assert.equal(await table.locator('.c-note').count(), 0)
      // A command that reads the case says nothing more of why it cannot: Problems says it
      // already, and a notification the test did not expect fails it.
      await vscode.commands.executeCommand('gridkitStudio.copyId', bench.uri)
      await vscode.commands.executeCommand('gridkitStudio.openSource', bench.uri)
      await until(
        () =>
          vscode.window.visibleTextEditors.some(
            (editor) => editor.document.uri.toString() === bench.uri.toString(),
          ),
        'the source in front',
      )
      // Undone as an edit of the source is, with VS Code's own undo.
      await bench.undo('the invalid edit undone')
    } finally {
      if (document.getText() !== text) await bench.replace(text)
    }
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
      { table: 'Bus', id: bus!.number, field: 'params.kv' },
      bus!.params.kv + 1,
    )
    await bench.settled()
    await bench.document.save()
    const diff = await git('diff', '--', 'IEEE39.case.json')
    assert.match(diff.stdout, /\+.*kv/)
    assert.ok(diff.stdout.length < 3000, 'A field edit should not reserialize the case')
    bench.report.gitDiffBytes = diff.stdout.length
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

  test('reads the catalog the Catalog setting names, and says why one does not read', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    const global = vscode.ConfigurationTarget.Global
    const file = vscode.Uri.joinPath(folder(), 'studio.catalog.json')
    const write = (text: string) =>
      vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text))
    const bundled = JSON.parse(catalog.text) as { bus: { classes: string[] } }
    const later = {
      ...bundled,
      bus: { ...bundled.bus, classes: [...bundled.bus.classes, 'SignalVoltageIn'] },
    }
    const said: unknown[] = []
    const read = () => catalogFile((error) => said.push(error))
    try {
      assert.equal(read(), undefined, 'none named, the bundled catalog is read')
      // A relative path is in the first workspace folder.
      await settings.update('catalog', 'studio.catalog.json', global)
      await write(JSON.stringify(later))
      assert.deepEqual(read(), later)
      assert.deepEqual(said, [])
      // A file that is no catalog is said, and the bundled catalog read in its place.
      for (const text of ['{', '{}']) {
        await write(text)
        assert.equal(read(), undefined)
      }
      assert.equal(said.length, 2)
      for (const error of said)
        assert.match(
          String(error),
          /studio\.catalog\.json is not a catalog GridKit Studio can read/,
        )
      assert.match(String(said[1]), /a bus and a list of classes/)
    } finally {
      await settings.update('catalog', undefined, global)
      await vscode.workspace.fs.delete(file).then(undefined, () => {})
    }
  })
})
