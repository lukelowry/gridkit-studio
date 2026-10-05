/** Workspace Trust, in a fresh profile with an untrusted folder: the case opens for inspection,
 *  and a run is refused. */

import assert from 'node:assert/strict'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import * as vscode from 'vscode'

import { registerTasks } from '../../src/extension/tasks.js'
import { extension, folder } from './harness.js'

export async function run(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false, 'The fixture must be an untrusted workspace')
  const { studio, mcp } = await extension().activate()
  // Only the run guard is under test; the extension registers its own task provider.
  const tasks = registerTasks(studio)
  tasks.provider.dispose()
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder(), 'IEEE39.case.json'),
  )
  const session = await studio.open(document)
  assert.ok(studio.state(session.uri).summary, 'Inspection remains available without trust')
  await assert.rejects(tasks.run(session.uri), /Trust this workspace/)
  await assert.rejects(
    async () =>
      vscode.lm.invokeTool('gridkit_propose_run', {
        input: { uri: session.uri, version: document.version },
        toolInvocationToken: undefined,
      }),
    /Trust this workspace/,
  )
  const client = new Client({ name: 'trust-test', version: '1' })
  try {
    await client.connect(new StdioClientTransport({ ...(await mcp.start()), stderr: 'pipe' }))
    const result = await client.callTool({
      name: 'gridkit_propose_run',
      arguments: { uri: session.uri, version: document.version },
    })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /Trust this workspace/)
  } finally {
    await client.close()
    await mcp.stop()
  }
  assert.equal(session.run, undefined)
  console.log('Workspace Trust: inspection allowed; execution blocked.')
}
