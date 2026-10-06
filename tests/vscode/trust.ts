/** Workspace Trust, in a fresh profile with an untrusted folder: the case opens for inspection,
 *  and a run is refused. */

import assert from 'node:assert/strict'

import * as vscode from 'vscode'

import { registerTasks } from '../../src/extension/tasks.js'
import { extension, folder } from './harness.js'

export async function run(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false, 'The fixture must be an untrusted workspace')
  const { studio } = await extension().activate()
  // Only the run guard is under test; the extension registers its own task provider.
  const tasks = registerTasks(studio)
  tasks.provider.dispose()
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder(), 'IEEE39.case.json'),
  )
  const session = await studio.open(document)
  assert.ok(studio.state(session.uri).summary, 'Inspection remains available without trust')
  await assert.rejects(tasks.simulate(session.uri), /Trust this workspace/)
  assert.equal(session.run, undefined)
  console.log('Workspace Trust: inspection allowed; execution blocked.')
}
