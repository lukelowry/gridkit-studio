/** Real SDK client -> packaged stdio relay -> live extension documents and approvals. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import * as vscode from 'vscode'

import type { MCP } from '../../src/extension/mcp.js'
import { extension, folder, until } from './harness.js'

export async function run() {
  const { studio, mcp } = await extension().activate()
  assert.equal(mcp.connected, false, 'MCP is opt-in')
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder(), 'IEEE39.case.json'),
  )
  await studio.open(document)
  const original = document.getText()
  const uri = document.uri.toString()
  const clients: Client[] = []
  let replacement: MCP | undefined
  const launch = await mcp.start()
  const client = async (parameters = launch) => {
    const value = new Client({ name: 'gridkit-integration-test', version: '1' })
    clients.push(value)
    await value.connect(new StdioClientTransport({ ...parameters, stderr: 'pipe' }))
    return value
  }
  try {
    const first = await client()
    const second = await client()
    const tools = (await first.listTools()).tools
    assert.equal(tools.length, 20)
    assert.equal(mcp.listening, true)
    await until(() => mcp.connected, 'MCP initialized client status')
    assert.equal((await mcp.test(launch)).tools, 20)
    // Commands write only this isolated test workspace and verify the real relay first.
    await mcp.configureProject('codex')
    const codex = await readFile(vscode.Uri.joinPath(folder(), '.codex/config.toml').fsPath, 'utf8')
    assert.ok(codex.includes('[mcp_servers.gridkit]'))
    assert.ok(codex.includes('ELECTRON_RUN_AS_NODE'))
    await mcp.configureProject('claude')
    const claude = JSON.parse(
      await readFile(vscode.Uri.joinPath(folder(), '.mcp.json').fsPath, 'utf8'),
    )
    assert.deepEqual(claude.mcpServers.gridkit, { type: 'stdio', ...launch })
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      vscode.lm.tools
        .filter((tool) => tool.name.startsWith('gridkit_'))
        .map((tool) => tool.name)
        .sort(),
    )
    const call = async (name: string, input: Record<string, unknown>, on = first) => {
      const result = await on.callTool({ name: 'gridkit_' + name, arguments: input })
      assert.ok(!result.isError, JSON.stringify(result))
      return result.structuredContent as Record<string, unknown>
    }
    const inspected = await call('inspect_case', { uri, from: 'Bus' })
    const discovered = await call('find_cases', {})
    assert.ok((discovered.cases as { uri: string }[]).some((item) => item.uri === uri))
    assert.equal((await call('open_case', { uri })).version, document.version)
    const native = await vscode.lm.invokeTool('gridkit_inspect_case', {
      input: { uri, from: 'Bus' },
      toolInvocationToken: undefined,
    })
    assert.deepEqual(
      inspected,
      JSON.parse((native.content[0] as vscode.LanguageModelTextPart).value),
    )
    // A client asks for as many rows as it wants.
    const every = await call('query_rows', {
      uri,
      version: document.version,
      from: 'Bus',
      select: ['name'],
      limit: 999,
    })
    assert.equal((every.rows as unknown[]).length, 39)
    const action = await call('propose_edits', {
      uri,
      version: document.version,
      changes: [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'MCP applied' }],
    })
    assert.equal(action.status, 'pending')
    assert.equal(document.getText(), original)
    assert.ok(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some(
          ({ input }) =>
            input instanceof vscode.TabInputTextDiff && input.modified.authority === action.action,
        ),
    )
    assert.equal((await call('action_status', { action: action.action })).status, 'pending')
    await vscode.commands.executeCommand(
      'gridkitStudio.approveAIProposal',
      vscode.Uri.parse(`gridkit-proposal://${action.action}/edit.json`),
    )
    await until(() => document.getText().includes('MCP applied'), 'MCP edit approval')
    assert.equal((await call('action_status', { action: action.action })).status, 'applied')
    assert.equal(document.isDirty, true)
    await call('inspect_case', { uri }, second)
    const rows = await call(
      'query_rows',
      { uri, version: document.version, from: 'Bus', select: ['name'], ids: ['Bus/1'] },
      second,
    )
    assert.ok(
      JSON.stringify(rows).includes('MCP applied'),
      'Another client reads the same unsaved document',
    )
    const discarded = await call('propose_edits', {
      uri,
      version: document.version,
      changes: [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'discard me' }],
    })
    await vscode.commands.executeCommand(
      'gridkitStudio.discardAIProposal',
      vscode.Uri.parse(`gridkit-proposal://${discarded.action}/edit.json`),
    )
    assert.equal((await call('action_status', { action: discarded.action })).status, 'discarded')
    const stale = await call('propose_edits', {
      uri,
      version: document.version,
      changes: [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'stale edit' }],
    })
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('undo')
    await until(() => document.getText() === original, 'undo MCP changes')
    assert.equal((await call('action_status', { action: stale.action })).status, 'stale')

    await call('inspect_case', { uri })
    const added = await call('propose_components', {
      uri,
      version: document.version,
      components: [
        {
          type: 'Branch',
          key: 'agent-created',
          fields: {
            'ports.bus1': 'Bus/1',
            'ports.bus2': 'Bus/999',
            'params.R': 0,
            'params.X': 0.1,
          },
        },
        { type: 'Bus', key: 999, fields: { name: 'Agent-created bus', 'params.kv': 230 } },
      ],
    })
    assert.equal(document.getText(), original)
    await vscode.commands.executeCommand(
      'gridkitStudio.approveAIProposal',
      vscode.Uri.parse(`gridkit-proposal://${added.action}/edit.json`),
    )
    await until(() => document.getText().includes('agent-created'), 'MCP component creation')
    await call('inspect_case', { uri })
    const neighbors = await call('inspect_neighborhood', {
      uri,
      version: document.version,
      id: 'Bus/999',
      network: 'electrical',
      hops: 2,
    })
    assert.equal(neighbors.nodes, 3)
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('undo')
    await until(() => document.getText() === original, 'undo atomic bus and branch creation')
    await call('inspect_case', { uri })
    const selected = await call('select_elements', {
      uri,
      version: document.version,
      from: 'Bus',
      ids: ['Bus/1'],
    })
    assert.equal(selected.count, 1)
    const aggregated = await call('aggregate_case', {
      uri,
      version: document.version,
      from: 'Bus',
      fields: ['params.kv'],
    })
    assert.equal(aggregated.matched, 39)
    const csv = vscode.Uri.joinPath(folder(), 'recorded.csv').fsPath
    const bus = JSON.parse(original).buses.find((bus: { number: number }) => bus.number === 1)
    await writeFile(csv, `time,Bus_${bus.name}_Vm\n0,1\n1,0.8\n2,1\n3,1\n`)
    const recorded = await studio.client.call('import', {
      uri,
      version: document.version,
      path: csv,
      cacheBytes: 16 << 20,
    })
    const background = await call('analyze_run', {
      uri,
      run: recorded.id,
      from: 'Bus',
      field: 'Vm',
      selection: selected.selection,
      background: true,
      metrics: [
        { kind: 'threshold', lower: 0.9, durationMethod: 'left-hold', maxGapSeconds: 1 },
        { kind: 'settling', after: 1, band: [0.9, 1.1], holdSeconds: 1, maxGapSeconds: 1 },
      ],
    })
    const completed = await call('analysis_job', { job: background.job, waitMs: 10000 })
    assert.equal(completed.status, 'complete')
    const analysis = completed.result as {
      evidence: string
      rows: { threshold: { estimatedSeconds: number }; settling: { settledAt: number } }[]
    }
    assert.equal(analysis.rows[0]!.threshold.estimatedSeconds, 1)
    assert.equal(analysis.rows[0]!.settling.settledAt, 2)
    const saved = await call('read_evidence', { evidence: analysis.evidence })
    assert.deepEqual(saved.rows, analysis.rows)
    const samples = await call('query_signals', {
      uri,
      run: recorded.id,
      from: 'Bus',
      field: 'Vm',
      ids: ['Bus/1'],
      window: [0, 3],
      representation: { kind: 'exact', maxSamples: 2 },
    })
    assert.equal(samples.nextOffset, 2)
    const historical = await call('summarize_run', {
      uri,
      run: recorded.id,
      include: ['configuration'],
    })
    assert.equal((historical.run as { configuration: unknown }).configuration, null)

    const directory = launch.args[2]!
    const recordPath = join(
      directory,
      (await readdir(directory)).find((name) => name.endsWith('.json'))!,
    )
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      address: string
      token: string
      instance: string
    }
    const socket = connect(record.address)
    let response = ''
    socket.on('data', (data) => {
      response += data.toString()
    })
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject).on('close', () => resolve())
      socket.on('connect', () => socket.write('connect ' + '0'.repeat(64) + '\n'))
    })
    assert.equal(response, '', 'Invalid credentials cannot enter MCP')
    const duplicate = join(directory, randomUUID() + '.json')
    await writeFile(duplicate, JSON.stringify(record))
    try {
      await assert.rejects(client(), /closed|connect|exit/i)
    } finally {
      await rm(duplicate)
    }
    // A new controller represents the next extension-host lifetime. Stable workspace config reconnects.
    await mcp.dispose()
    await assert.rejects(first.listTools())
    const Controller = mcp.constructor as typeof MCP
    replacement = new Controller(studio, mcp.tools)
    const next = await replacement.start()
    assert.deepEqual(next, launch)
    const reconnected = await client()
    assert.equal((await reconnected.listTools()).tools.length, 20)
    await replacement.stop()
    const cancelledStart = replacement.start().then(
      () => false,
      () => true,
    )
    await replacement.stop()
    assert.equal(await cancelledStart, true, 'Disconnect cancels an in-flight startup')
    assert.equal(replacement.connected, false)
    // VS Code keeps disabled tools in lm.tools; when gates chat availability, not API calls.
    assert.ok(
      extension().packageJSON.contributes.languageModelTools.every(
        (tool: { when: string }) => tool.when === '!gridkitStudio.mcpChat',
      ),
    )
    assert.deepEqual(studio.errors.splice(0), [])
    console.log(
      'MCP: real stdio client, native parity, shared unsaved state, approval/status, schema validation, authentication, ambiguous windows, disconnect and reload passed.',
    )
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => {})))
    await replacement?.dispose()
    await mcp.stop()
  }
}
