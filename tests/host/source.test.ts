/** The case's file: one written so it does not read, one that never read, and the catalog of
 *  GridKit's classes the case is read with. What is wrong with a file Problems says, and nothing
 *  else. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { catalogFile } from '../../src/extension/catalog.js'
import { catalog } from '../../src/gridkit/index.js'
import { type Bench, bench, folder, until } from './studio.js'

suite('Source', () => {
  let host: Bench

  suiteSetup(async () => {
    host = await bench()
  })

  test('keeps the last case that read while its file does not, and Problems says why', async () => {
    const { version } = host.studio.state(host.key).summary!
    await host.write('{' + host.text)
    try {
      await until(() => vscode.languages.getDiagnostics(host.uri).length, 'Problems lists why')
      const state = host.studio.state(host.key)
      assert.equal(state.stale, true)
      assert.equal(state.summary?.version, version, 'the views keep the case that read')
      // A command on the case says nothing more of why it cannot read: Problems says it already.
      await vscode.commands.executeCommand('gridkitStudio.copyId', host.uri)
      await vscode.commands.executeCommand('gridkitStudio.openSource', host.uri)
    } finally {
      await host.write(host.text)
    }
    await until(
      () => !vscode.languages.getDiagnostics(host.uri).length && !host.studio.state(host.key).stale,
      'the file reads again',
    )
    // Read again as it was, it is the case that read before.
    assert.equal(host.studio.state(host.key).summary?.version, version)
  })

  test('says why a case file does not read in Problems alone, and reads it once repaired', async () => {
    const uri = vscode.Uri.joinPath(folder(), 'invalid.case.json')
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('{'))
    await host.follow(uri).catch(() => {})
    await until(() => host.studio.state(uri.toString()).error, 'the parse error noticed')
    assert.ok(vscode.languages.getDiagnostics(uri).length, 'Problems lists why')
    await host.write(host.text, uri)
    await until(
      () => !host.studio.state(uri.toString()).error && host.studio.state(uri.toString()).summary,
      'the repaired case reads',
    )
    assert.deepEqual(vscode.languages.getDiagnostics(uri), [])
  })

  test('reads a case file larger than VS Code gives an extension, as GridKit has it', async function () {
    // ACTIVSg70k as GridKit writes it, 94 MB: past the 50 MB of text VS Code gives an extension.
    this.timeout(120_000)
    const uri = await host.copy('cases/ACTIVSg70k.case.json')
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.network')
      const summary = await until(
        () => host.studio.state(uri.toString()).summary,
        'ACTIVSg70k read',
        120_000,
      )
      assert.equal(summary.counts.Bus, 70_000)
      assert.deepEqual(host.said(), [])
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.workspace.fs.delete(uri)
    }
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
