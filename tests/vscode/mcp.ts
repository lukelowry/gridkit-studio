/** Actual SDK client -> packaged stdio relay -> extension -> worker and GridKit. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import * as vscode from 'vscode'

import type { MCP } from '../../src/extension/ai/mcp.js'
import { exerciseTools, type Call } from './ai-contract.js'
import { extension, folder, until } from './harness.js'

export async function run() {
  const { studio, mcp } = await extension().activate()
  assert.equal(mcp.connected, false)
  const clients: Client[] = []
  let replacement: MCP | undefined
  const launch = await mcp.start()
  const connectClient = async () => {
    const client = new Client({ name: 'gridkit-integration-test', version: '2' })
    clients.push(client)
    await client.connect(new StdioClientTransport({ ...launch, stderr: 'pipe' }))
    return client
  }
  try {
    const first = await connectClient()
    const tools = (await first.listTools()).tools
    assert.equal(tools.length, 20)
    assert.ok(!tools.some(tool => /propose|_run|action_status/.test(tool.name)))
    await until(() => mcp.connected, 'initialized MCP client status')
    assert.equal((await mcp.test(launch)).tools, 20)
    const denied = await first.callTool({ name: 'gridkit_simulate', arguments: { caseUri: vscode.Uri.joinPath(folder(), 'IEEE39.case.json').toString(), requestId: 'denied', program: 'DynamicSimulation' } })
    assert.equal(denied.isError, true)
    assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'capability-disabled')
    // Test authorization is explicitly scoped to this disposable profile, never the real workspace.
    await studio.context.workspaceState.update('mcp.access', 'edit')
    await mcp.configureProject('codex')
    const codex = await readFile(vscode.Uri.joinPath(folder(), '.codex/config.toml').fsPath, 'utf8')
    assert.ok(codex.includes('[mcp_servers.gridkit]') && codex.includes('ELECTRON_RUN_AS_NODE'))
    await mcp.configureProject('claude')
    assert.deepEqual(JSON.parse(await readFile(vscode.Uri.joinPath(folder(), '.mcp.json').fsPath, 'utf8')).mcpServers.gridkit, { type: 'stdio', ...launch })
    assert.deepEqual(tools.map(tool => tool.name).sort(), vscode.lm.tools.filter(tool => tool.name.startsWith('gridkit_')).map(tool => tool.name).sort())
    const callOn = (client: Client): Call => async (name, input) => {
      const response = await client.callTool({ name: 'gridkit_' + name, arguments: input })
      if (response.isError) throw new Error(JSON.stringify(response.structuredContent ?? response.content))
      return response.structuredContent as Record<string, unknown>
    }
    const saved = await exerciseTools(studio, callOn(first), true)
    const second = await connectClient()
    assert.deepEqual((await callOn(second)('get_analysis', { analysisId: saved.analysisId })).items, saved.findings)
    const directory = launch.args[2]!
    const recordPath = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!)
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { address: string; token: string }
    const socket = connect(record.address)
    let response = ''
    socket.on('data', data => { response += data.toString() })
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject).on('close', () => resolve())
      socket.on('connect', () => socket.write('connect ' + '0'.repeat(64) + '\n'))
    })
    assert.equal(response, '')
    const duplicate = join(directory, randomUUID() + '.json')
    await writeFile(duplicate, JSON.stringify(record))
    try { await assert.rejects(connectClient(), /closed|connect|exit/i) }
    finally { await rm(duplicate) }
    await mcp.dispose()
    await assert.rejects(first.listTools())
    const Controller = mcp.constructor as typeof MCP
    replacement = new Controller(studio, mcp.tools)
    assert.deepEqual(await replacement.start(), launch)
    const reconnected = await connectClient()
    assert.equal((await reconnected.listTools()).tools.length, 20)
    assert.deepEqual((await callOn(reconnected)('get_analysis', { analysisId: saved.analysisId })).items, saved.findings)
    await replacement.stop()
    const cancelledStart = replacement.start().then(() => false, () => true)
    await replacement.stop()
    assert.equal(await cancelledStart, true)
    assert.deepEqual(studio.errors.splice(0), [])
    console.log('MCP: 20 tools, access scopes, Codex/Claude configuration, real simulation, exact metrics, atomic edits, retry, reconnect and authentication verified.')
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => {})))
    await replacement?.dispose()
    await mcp.stop()
  }
}
