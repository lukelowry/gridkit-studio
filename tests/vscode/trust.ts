import assert from 'node:assert/strict'

import * as vscode from 'vscode'

import type { Sessions } from '../../src/extension/sessions.js'
import { registerTasks } from '../../src/extension/tasks.js'

/** Runs in a fresh profile with Workspace Trust enabled and an untrusted folder. */
export async function run(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false, 'The fixture must be an untrusted workspace')
  const extension = vscode.extensions.getExtension<{ studio: Sessions }>(
    'lukelowery.gridkit-studio',
  )!
  const { studio } = await extension.activate()
  const tasks = registerTasks(studio)
  try {
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'IEEE39.case.json')
    const document = await vscode.workspace.openTextDocument(uri)
    const session = await studio.open(document)
    assert.ok(studio.state(session.uri).summary, 'Inspection remains available without trust')
    await assert.rejects(tasks.run(session.uri), /Trust this workspace/)
    assert.equal(session.run, undefined)
    console.log('Workspace Trust: inspection allowed; execution blocked.')
  } finally {
    tasks.provider.dispose()
  }
}
