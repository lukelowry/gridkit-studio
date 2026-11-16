/** Case files that fail to parse, oversized cases, and the Catalog setting. Parse errors are
 *  reported only in Problems. */

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

  test('keeps the last case that read while its file does not, and Problems explains why', async () => {
    const { version } = host.studio.state(host.key).summary!
    await host.write('{' + host.text)
    try {
      await until(() => vscode.languages.getDiagnostics(host.uri).length, 'Problems lists why')
      const state = host.studio.state(host.key)
      assert.equal(state.stale, true)
      assert.equal(state.summary?.version, version, 'the views keep the case that read')
      // Commands on the case add no error of their own; Problems already reports it.
      await vscode.commands.executeCommand('gridkitStudio.copyId', host.uri)
      await vscode.commands.executeCommand('gridkitStudio.showJson', host.uri)
    } finally {
      await host.write(host.text)
    }
    await until(
      () => !vscode.languages.getDiagnostics(host.uri).length && !host.studio.state(host.key).stale,
      'the file reads again',
    )
    // Restoring the original text yields the same version.
    assert.equal(host.studio.state(host.key).summary?.version, version)
  })

  test('explains in Problems only why a case file does not read, and reads it once repaired', async () => {
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
    // ACTIVSg70k is 94 MB, past the 50 MB of text VS Code gives an extension.
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
      assert.deepEqual(host.takeErrors(), [])
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.workspace.fs.delete(uri)
    }
  })

  test('reads the catalog the Catalog setting names, and explains why one does not read', async () => {
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
    const reported: unknown[] = []
    const read = () => catalogFile((error) => reported.push(error))
    try {
      assert.equal(await read(), undefined, 'none named, the bundled catalog is read')
      // A relative path resolves against the first workspace folder.
      await settings.update('catalog', 'studio.catalog.json', global)
      await write(JSON.stringify(later))
      assert.deepEqual(await read(), later)
      assert.deepEqual(reported, [])
      // An invalid catalog is reported and the bundled catalog used instead.
      for (const text of ['{', '{}']) {
        await write(text)
        assert.equal(await read(), undefined)
      }
      assert.equal(reported.length, 2)
      for (const error of reported)
        assert.match(
          String(error),
          /studio\.catalog\.json is not a catalog GridKit Studio can read/,
        )
      assert.match(String(reported[1]), /needs case, bus and classes entries/)
    } finally {
      await settings.update('catalog', undefined, global)
      await vscode.workspace.fs.delete(file).then(undefined, () => {})
    }
  })
})
