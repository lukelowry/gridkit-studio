import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'

import type { Mutation, RunRequest } from '../shared/messages.js'
import { Proposals } from './proposals.js'
import type { Sessions } from './sessions.js'
import type { Tasks } from './tasks.js'

vi.mock('vscode', () => ({
  Uri: { parse: (value: string) => value },
  workspace: {
    fs: { isWritableFileSystem: () => true },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: vi.fn(async () => {}) },
  window: {
    showTextDocument: vi.fn(async () => {}),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
}))

function fixture() {
  const revision = { uri: 'file:///case', version: 1 }
  const entry = {
    document: {
      version: 1,
      isClosed: false,
      uri: { scheme: 'file' },
      getText: () => '{"name":"old"}',
    },
    stale: false,
  }
  const transact = vi.fn(async () => {})
  const run = vi.fn(async () => {})
  const studio = {
    documents: {
      entries: new Map([[revision.uri, entry]]),
      changed: { event: () => ({ dispose() {} }) },
      require: () => {
        if (entry.document.version !== 1 || entry.stale) throw new Error('stale')
      },
      transact,
    },
  } as unknown as Sessions
  const proposals = new Proposals(studio, { run } as unknown as Tasks)
  return { revision, entry, transact, run, proposals }
}
afterEach(() => vi.restoreAllMocks())

describe('reviewed AI proposals', () => {
  it('previews without writing, captures values, consumes approval once, and retains native transactions', async () => {
    const { revision, proposals, transact } = fixture()
    const changes: Mutation[] = [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'new' }]
    const proposed = proposals.edit(revision, changes, [{ offset: 9, length: 3, text: 'new' }])
    expect(proposals.get(proposed.proposal).after).toBe('{"name":"new"}')
    expect(transact).not.toHaveBeenCalled()
    changes[0] = { kind: 'set', id: 'Bus/1', field: 'name', value: 'changed after preview' }
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Apply edits' as never)
    await proposals.review(proposed.proposal)
    expect(transact).toHaveBeenCalledWith(
      revision.uri,
      1,
      [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'new' }],
      'Apply AI proposal',
    )
    await expect(proposals.review(proposed.proposal)).rejects.toThrow(/consumed/)
    expect(transact).toHaveBeenCalledTimes(1)
    proposals.dispose()
  })
  it('refuses changed or expired proposals and never silently retargets an approved run', async () => {
    const { revision, proposals, entry, run } = fixture()
    const request: RunRequest = {
      ...revision,
      values: { tmax: 1 },
      outputs: [{ from: 'Bus', select: ['Vm'] }],
      gridkit: { path: 'captured', image: '', cli: '' },
      cacheBytes: 16 << 20,
    }
    const first = proposals.run(request, { scenarios: 1 })
    request.values.tmax = 99
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Run simulation' as never)
    await proposals.review(first.proposal)
    expect(run).toHaveBeenCalledWith(
      revision.uri,
      expect.objectContaining({
        values: { tmax: 1 },
        gridkit: { path: 'captured', image: '', cli: '' },
      }),
    )
    const stale = proposals.run(request, {})
    vi.mocked(vscode.window.showInformationMessage).mockImplementation(async () => {
      entry.document.version = 2
      return 'Run simulation' as never
    })
    await expect(proposals.review(stale.proposal)).rejects.toThrow(/case changed/)
    expect(run).toHaveBeenCalledTimes(1)
    entry.document.version = 1
    const expired = proposals.run(request, {})
    vi.spyOn(Date, 'now').mockReturnValue(expired.expires + 1)
    expect(() => proposals.get(expired.proposal)).toThrow(/expired/)
    proposals.dispose()
  })
})
