/** Workspace Trust, in a fresh profile with an untrusted folder: the case opens for inspection,
 *  and a run of its solver file is refused. */

import assert from 'node:assert/strict'

import * as vscode from 'vscode'

import { extension, folder } from './harness.js'

export async function run(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false, 'The fixture must be an untrusted workspace')
  const { studio } = await extension().activate()
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder(), 'IEEE39.case.json'),
  )
  const session = await studio.open(document)
  assert.ok(studio.state(session.uri).summary, 'Inspection remains available without trust')
  // A command whose enablement fails runs anyway when called; the run itself refuses.
  const errors = studio.errors.length
  await vscode.commands.executeCommand(
    'gridkitStudio.runSimulation',
    vscode.Uri.joinPath(folder(), 'IEEE39.solver.json'),
  )
  assert.match(studio.errors.slice(errors).join('\n'), /Trust this workspace/)
  assert.equal(session.run, undefined)
  console.log('Workspace Trust: inspection allowed; execution blocked.')
}
