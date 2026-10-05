/** Native language-model API contract, independent of model credentials and GPU rendering. */
import assert from 'node:assert/strict'

import * as vscode from 'vscode'

import { registerTasks } from '../../src/extension/tasks.js'
import type { Analysis, Comparison } from '../../src/shared/analysis.js'
import type { Requests, RunRequest } from '../../src/shared/messages.js'
import { extension, folder, until } from './harness.js'

export async function run() {
  const { studio } = await extension().activate()
  const invoke = async <T>(
    name: string,
    input: object,
    tokenizationOptions?: vscode.LanguageModelToolTokenizationOptions,
  ): Promise<T> => {
    const result = await vscode.lm.invokeTool('gridkit_' + name, {
      input,
      toolInvocationToken: undefined,
      tokenizationOptions,
    })
    const text = result.content
      .filter((part) => part instanceof vscode.LanguageModelTextPart)
      .map((part) => part.value)
      .join('')
    return JSON.parse(text) as T
  }
  assert.equal(vscode.lm.tools.filter((tool) => tool.name.startsWith('gridkit_')).length, 10)
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder(), 'IEEE39.case.json'),
  )
  const session = await studio.open(document)
  const uri = document.uri.toString()
  const revision = { uri, version: document.version }
  const discovery = await invoke<{ cases: { uri: string }[] }>('inspect_case', {})
  assert.ok(discovery.cases.some((item) => item.uri === uri))
  const inspected = await invoke<{
    revision: object
    types: { identity: string; editable: string[] }[]
  }>('inspect_case', { uri, from: 'Bus' })
  assert.deepEqual(inspected.revision, revision)
  assert.equal(inspected.types[0]!.identity, 'number')
  assert.ok(inspected.types[0]!.editable.includes('name'))
  const first = await invoke<{ rows: { id: string }[]; total: number; nextOffset: number }>(
    'query_rows',
    {
      ...revision,
      from: 'Bus',
      select: ['name', 'params.kv'],
      limit: 2,
      orderBy: [{ field: 'number', direction: 'descending' }],
    },
  )
  assert.equal(first.rows.length, 2)
  assert.equal(first.total, 39)
  assert.equal(first.nextOffset, 2)
  const next = await invoke<{ rows: { id: string }[] }>('query_rows', {
    ...revision,
    from: 'Bus',
    select: ['name'],
    offset: first.nextOffset,
    limit: 2,
    orderBy: [{ field: 'number', direction: 'descending' }],
  })
  assert.notEqual(first.rows[0]!.id, next.rows[0]!.id)
  const bounded = await invoke<{ rows: unknown[]; nextOffset: number; truncated: boolean }>(
    'query_rows',
    { ...revision, from: 'Bus', select: ['name', 'params.kv'], limit: 39 },
    { tokenBudget: 750, countTokens: async (text) => text.length },
  )
  assert.ok(bounded.rows.length > 0 && bounded.rows.length < 39)
  assert.equal(bounded.nextOffset, bounded.rows.length)
  assert.equal(bounded.truncated, true)
  await assert.rejects(
    invoke('query_rows', { ...revision, version: 999, from: 'Bus', select: ['name'] }),
    /changed|invalid/,
  )
  const original = document.getText()
  const proposal = await invoke<{ proposal: string }>('propose_edits', {
    ...revision,
    changes: [{ kind: 'set', id: first.rows[0]!.id, field: 'name', value: 'AI review only' }],
  })
  const preview = await vscode.workspace.openTextDocument(
    vscode.Uri.parse(`gridkit-proposal://${proposal.proposal}/after.json`),
  )
  assert.ok(preview.getText().includes('AI review only'))
  assert.equal(document.getText(), original)
  const tasks = registerTasks(studio)
  tasks.provider.dispose()
  const execute = async (values: Record<string, unknown>) => {
    const proposal = await invoke<{ proposal: string }>('propose_run', {
      ...revision,
      values,
      outputs: [{ from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1', 'Bus/2'] } }],
    })
    const preview = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(`gridkit-proposal://${proposal.proposal}/after.json`),
    )
    const { request } = JSON.parse(preview.getText()) as { request: RunRequest }
    const previous = session.run?.id
    session.values = { tmax: 99, fault: false }
    // Execute exactly what the review captured, after changing the live settings.
    await tasks.run(uri, request)
    const completed = await until(
      () =>
        session.run?.id !== previous && session.run?.state !== 'running' ? session.run : undefined,
      'the captured AI simulation task',
    )
    assert.equal(completed.state, 'complete', completed.message)
    assert.equal(completed.domain[1], values.tmax)
    return completed
  }
  assert.equal(studio.all.get(uri)?.run, undefined, 'An edit proposal must not start a simulation')
  const dynamic = await execute({
    program: 'DynamicSimulation',
    tmax: 0.02,
    dt_monitor: 0.01,
    fault: false,
  })
  const measured = await invoke<Analysis>('analyze_run', {
    uri,
    run: dynamic.id,
    from: 'Bus',
    field: 'Vm',
  })
  assert.equal(measured.total, 2)
  assert.equal(measured.rows[0]!.valid, 3)
  await invoke('show_element', {
    ...revision,
    action: 'plot',
    id: 'Bus/1',
    field: 'Vm',
    run: dynamic.id,
  })
  assert.ok(session.plots.some((plot) => plot.id === 'Bus/1' && plot.field === 'Vm'))
  const study = await execute({
    program: 'ContingencyAnalysis',
    tmax: 0.02,
    dt_monitor: 0.005,
    fault_start: 0.005,
    fault_duration: 0.005,
    fault_R: 0,
    fault_X: 0.01,
  })
  const studyId = study.contingency!.study
  const switched = await studio.client.call('contingency', { run: study.id, shown: 1 })
  await until(() => session.run?.id === switched.id, 'the displayed contingency')
  const ranking = await invoke<Requests['rank']['output']>('rank_contingencies', {
    uri,
    run: studyId,
    from: 'Bus',
    field: 'Vm',
    contingencies: [0, 1],
  })
  assert.equal(ranking.total, 2)
  assert.ok(ranking.rows.every((row) => row.state === 'measured'))
  assert.equal(session.run?.id, switched.id, 'Ranking must not switch the displayed contingency')
  const compared = await invoke<Comparison>('compare_runs', {
    before: { uri, run: dynamic.id },
    after: { uri, run: studyId, contingency: 0 },
    from: 'Bus',
    field: 'Vm',
  })
  assert.equal(compared.matched, 2)
  assert.ok(compared.rows.some((row) => row.minDelta !== 0))
  const summarized = await invoke<{
    current: { retained: boolean }
    previous: { retained: boolean }
  }>('summarize_run', { uri })
  assert.equal(summarized.current.retained, true)
  assert.equal(summarized.previous.retained, true)
  await studio.client.call('clear', { uri })
  assert.equal((await studio.client.call('stats', {})).cacheBytes, 0)
  const invalid = await vscode.workspace.openTextDocument({ language: 'json', content: '{' })
  studio.activate(invalid.uri.toString())
  await studio.documents.ensure(invalid).catch(() => {})
  const diagnostics = await invoke<{
    diagnostics: unknown[]
    diagnosticsVersion: number
    parsedVersion?: number
  }>('read_diagnostics', { uri: invalid.uri.toString() })
  assert.ok(diagnostics.diagnostics.length > 0)
  assert.equal(diagnostics.diagnosticsVersion, invalid.version)
  assert.equal(diagnostics.parsedVersion, undefined)
  const explicit = await invoke<{ rows: unknown[] }>('query_rows', {
    ...revision,
    from: 'Bus',
    select: ['name'],
    limit: 1,
  })
  assert.equal(explicit.rows.length, 1, 'Switching active case must not retarget a tool')
  console.log(
    'AI native tools: discovery, targeting, pagination, budgets, diagnostics, previews, captured tasks, plots, analysis, comparison, contingency ranking and cleanup passed.',
  )
}
