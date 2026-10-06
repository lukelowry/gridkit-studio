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
  await assert.rejects(tasks.simulate(session.uri), /Trust this workspace/)
  const input = { caseUri: session.uri, requestId: 'trust-test', program: 'DynamicSimulation' }
  const native = await vscode.lm.invokeTool('gridkit_simulate', {
    input,
    toolInvocationToken: undefined,
  })
  assert.match(JSON.stringify(native.content), /Trust this workspace/)
  const client = new Client({ name: 'trust-test', version: '1' })
  try {
    await client.connect(new StdioClientTransport({ ...(await mcp.start()), stderr: 'pipe' }))
    const result = await client.callTool({
      name: 'gridkit_simulate',
      arguments: input,
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
