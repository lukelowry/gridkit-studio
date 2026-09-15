import { expect, it, vi } from 'vitest'
import * as vscode from 'vscode'

import type { Cases, ReadyCase } from '../src/case.js'
import { commitSetup } from '../src/simulation/setup.js'

function fixture() {
  const input = {
    system_model_file: 'case.case.json',
    tmax: 10,
    events: [{ time: 1, type: 'fault_on', element_id: 0 }],
  }
  const uri = { fsPath: 'case.solver.json' } as vscode.Uri
  const configuration = { getText: () => JSON.stringify(input), version: 1 } as vscode.TextDocument
  const state = {
    target: { uri: 'file:///case.case.json', version: 1, revision: 'r' },
    current: () => true,
    setup: { kind: 'document', uri },
    setSetup: vi.fn(),
    document: { getText: () => '{}', version: 1 },
  } as unknown as ReadyCase
  vi.mocked(vscode.workspace.openTextDocument).mockReset().mockResolvedValue(configuration)
  const cases = { edit: vi.fn(async () => {}) } as unknown as Cases
  const setup = state.setup
  const target = state.target
  const before = structuredClone(input)
  const commit = () => commitSetup(cases, state, target, setup, before, { ...before, tmax: 20 })
  return { state, cases, input, commit }
}
it('rejects a submission after switching configuration even when the case is unchanged', async () => {
  const { state, cases, commit } = fixture()
  state.setup = { kind: 'memory', options: { tmax: 10, events: [] } }
  await expect(commit()).rejects.toThrow('configuration changed')
  expect(cases.edit).not.toHaveBeenCalled()
})
it('rejects stale event indexes after editing the same configuration', async () => {
  const { cases, input, commit } = fixture()
  input.events = [{ time: 2, type: 'fault_on', element_id: 7 }]
  await expect(commit()).rejects.toThrow('configuration changed')
  expect(cases.edit).not.toHaveBeenCalled()
})
it('reads the configuration once and submits a single versioned edit transaction', async () => {
  const { state, cases, commit } = fixture()
  await commit()
  expect(vscode.workspace.openTextDocument).toHaveBeenCalledTimes(1)
  expect(cases.edit).toHaveBeenCalledTimes(1)
  expect(cases.edit).toHaveBeenCalledWith([
    expect.objectContaining({ document: state.document, version: 1, edits: [] }),
    expect.objectContaining({ version: 1, edits: expect.any(Array) }),
  ])
  expect(state.setSetup).toHaveBeenCalledWith(state.setup)
})
