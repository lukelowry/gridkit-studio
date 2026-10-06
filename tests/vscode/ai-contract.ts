import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

import * as vscode from 'vscode'

import type { Sessions } from '../../src/extension/sessions.js'
import { folder, until } from './harness.js'

export type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>

/** Exercise public contracts against real documents, undo, worker computations and native tasks. */
export async function exerciseTools(studio: Sessions, call: Call, simulate = false) {
  const caseUri = vscode.Uri.joinPath(folder(), 'IEEE39.case.json').toString()
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const listed = await call('list_cases', {})
  assert.ok((listed.items as { caseUri: string }[]).some(item => item.caseUri === caseUri))
  const description = await call('describe_case', { caseUri })
  const reference = { caseUri, caseRevision: description.caseRevision }
  assert.equal(typeof reference.caseRevision, 'string')
  const schema = await call('describe_component_type', { caseUri, componentType: 'Bus' })
  assert.equal(schema.identity, 'number')
  assert.ok((schema.editable as string[]).includes('name'))
  const rows = await call('find_components', { ...reference, componentType: 'Bus', fields: ['name', 'params.kv'], limit: 2, saveSelection: true })
  assert.equal(rows.total, 39)
  assert.equal(rows.selectionCount, 39)
  assert.equal(rows.nextOffset, 2)
  const next = await call('find_components', { ...reference, componentType: 'Bus', fields: ['name'], limit: 2, offset: 2 })
  assert.notDeepEqual(rows.items, next.items)
  const aggregate = await call('summarize_components', { ...reference, componentType: 'Bus', fields: ['params.kv'] })
  assert.equal(aggregate.matched, 39)
  assert.equal((await call('check_case', { caseUri })).valid, true)
  assert.ok((await call('trace_connections', { ...reference, componentId: 'Bus/1', network: 'electrical', hops: 1 })).nodes)
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(caseUri))
  const original = document.getText()
  const edit = {
    ...reference, requestId: randomUUID(), changes: [
      { kind: 'add', componentType: 'Branch', key: 'agent-tie', fields: { 'ports.bus1': 'Bus/99999', 'ports.bus2': 'Bus/1', 'params.X': 0.1 } },
      { kind: 'add', componentType: 'Bus', key: 99999, fields: { name: 'Agent bus', 'params.kv': 230 } },
      { kind: 'set', componentId: 'Bus/1', field: 'name', value: 'Agent edit' },
    ],
  }
  const applied = await call('edit_case', edit)
  assert.equal(applied.status, 'applied')
  assert.equal(JSON.parse(document.getText()).buses.length, 40)
  assert.deepEqual(await call('edit_case', edit), applied, 'Identical retries return the same receipt')
  await assert.rejects(call('edit_case', { ...edit, changes: [{ kind: 'set', componentId: 'Bus/1', field: 'name', value: 'different' }] }), /request-conflict/)
  await assert.rejects(call('edit_case', { ...edit, requestId: randomUUID() }), /revision-conflict/)
  await call('show_component', { caseUri, componentId: 'Bus/99999' })
  await vscode.window.showTextDocument(document)
  await vscode.commands.executeCommand('undo')
  await until(() => document.getText() === original, 'one undo restores the entire mixed transaction')
  await call('describe_case', { caseUri })
  const bus = JSON.parse(original).buses.find((bus: { number: number }) => bus.number === 1)
  const csv = vscode.Uri.joinPath(folder(), 'recorded.csv').fsPath
  await writeFile(csv, `time,Bus_${bus.name}_Vm\n0,1\n1,0.8\n2,1\n3,1\n`)
  const recorded = await studio.client.call('import', { uri: caseUri, version: document.version, path: csv, cacheBytes: 16 << 20 })
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const started = await call('analyze_results', {
    simulationId: recorded.id, componentType: 'Bus', field: 'Vm', componentIds: ['Bus/1'],
    metrics: [{ kind: 'threshold', lower: 0.9, durationMethod: 'left-hold', maxGapSeconds: 1 }, { kind: 'settling', after: 1, band: [0.9, 1.1], holdSeconds: 1, maxGapSeconds: 1 }],
  })
  const findings = await call('get_analysis', { analysisId: started.analysisId, waitMs: 10000 })
  assert.equal(findings.status, 'complete')
  assert.equal(findings.analysisId, started.analysisId)
  const measured = (findings.items as { threshold: { estimatedSeconds: number }; settling: { settledAt: number } }[])[0]!
  assert.equal(measured.threshold.estimatedSeconds, 1)
  assert.equal(measured.settling.settledAt, 2)
  assert.deepEqual((await call('get_analysis', { analysisId: started.analysisId })).items, findings.items)
  const comparison = await call('compare_results', { before: { simulationId: recorded.id }, after: { simulationId: recorded.id }, componentType: 'Bus', field: 'Vm', waitMs: 10000 })
  assert.equal((comparison.items as { minDelta: number }[])[0]!.minDelta, 0)
  const samples = await call('read_signal_samples', { simulationId: recorded.id, componentType: 'Bus', field: 'Vm', componentIds: ['Bus/1'], timeRange: [0, 3], representation: { kind: 'exact', maxSamples: 2 } })
  assert.equal(samples.nextOffset, 2)
  assert.equal((await call('stop_analysis', { analysisId: started.analysisId })).status, 'complete')
  await call('plot_results', { simulationId: recorded.id, componentType: 'Bus', field: 'Vm', componentId: 'Bus/1' })
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal(studio.errors.length, 0, 'Plot imported recording: ' + studio.errors[0])
  assert.equal(studio.all.get(caseUri)?.run?.id, recorded.id)
  assert.ok((await call('list_simulations', {})).items)
  assert.equal((await call('get_simulation', { simulationId: recorded.id, retainRecording: true })).recordingEvicted, false)
  if (simulate) {
    const input = { caseUri, requestId: randomUUID(), program: 'DynamicSimulation', parameters: { tmax: 0.1, dt_monitor: 0.01, fault: false }, recording: [{ componentType: 'Bus', fields: ['Vm'], componentIds: ['Bus/1', 'Bus/2'] }] }
    const receipt = await call('simulate', input)
    assert.equal(typeof receipt.simulationId, 'string')
    assert.equal((await call('simulate', input)).simulationId, receipt.simulationId)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const final = await until(async () => {
      const info = await call('get_simulation', { simulationId: receipt.simulationId, include: ['configuration', 'recording', 'logs'] })
      return ['complete', 'failed', 'cancelled', 'interrupted'].includes(String(info.status)) ? info : undefined
    }, 'accepted simulation completes independently of editor lifetime', 120000)
    assert.equal(final.status, 'complete', JSON.stringify(final))
    assert.ok(Number(final.frames) > 0)
    const live = await call('analyze_results', { simulationId: receipt.simulationId, componentType: 'Bus', field: 'Vm', waitMs: 10000 })
    assert.equal(studio.errors.length, 0, 'Plot new simulation: ' + studio.errors[0])
    assert.equal(live.status, 'complete', JSON.stringify(live))
    assert.equal(live.total, 2)
    assert.equal((await call('stop_simulation', { simulationId: receipt.simulationId })).status, 'complete')
  }
  return { caseUri, simulationId: recorded.id, analysisId: started.analysisId, findings: findings.items }
}
