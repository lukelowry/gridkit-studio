/** Workspace Trust in a fresh profile with an untrusted folder: cases open, runs are refused. */

import assert from 'node:assert/strict'

import * as vscode from 'vscode'

import { extension, folder } from './studio.js'

export async function run(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false, 'The fixture must be an untrusted workspace')
  const { studio } = await extension().activate()
  const session = await studio.open(vscode.Uri.joinPath(folder(), 'IEEE39.case.json').toString())
  assert.ok(studio.state(session.uri).summary, 'Inspection remains available without trust')
  // Enablement does not stop a direct call, so the run itself must refuse.
  const errors = studio.reporter.errors.length
  await vscode.commands.executeCommand(
    'gridkitStudio.runSimulation',
    vscode.Uri.joinPath(folder(), 'IEEE39.solver.json'),
  )
  assert.match(studio.reporter.errors.slice(errors).join('\n'), /Trust this workspace/)
  assert.equal(session.run, undefined)
  console.log('Workspace Trust: inspection allowed; execution blocked.')
}
