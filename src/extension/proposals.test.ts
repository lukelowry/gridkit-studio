import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'

import type { Mutation, RunRequest } from '../shared/messages.js'
import { Proposals } from './proposals.js'
import type { Sessions } from './sessions.js'
import type { Tasks } from './tasks.js'

vi.mock('vscode', () => ({
  Range: class {
    constructor(
      readonly start: { character: number },
      readonly end: { character: number },
    ) {}
  },
  Uri: { parse: (value: string) => value },
  TabInputText: class {},
  TabInputTextDiff: class {},
  workspace: {
    fs: { isWritableFileSystem: () => true },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
  },
  commands: { executeCommand: vi.fn(async () => {}) },
  window: {
    showTextDocument: vi.fn(async () => {}),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    tabGroups: { all: [], close: vi.fn(async () => true) },
  },
}))

function fixture() {
  const revision = { uri: 'file:///case', version: 1 }
  const entry = {
    document: {
      version: 1,
      isClosed: false,
      uri: { scheme: 'file' },
      positionAt: (offset: number) => ({ line: 0, character: Math.min(offset, 14) }),
      offsetAt: (position: { character: number }) => position.character,
      getText: (range?: { start: { character: number }; end: { character: number } }) =>
        range
          ? '{"name":"old"}'.slice(range.start.character, range.end.character)
          : '{"name":"old"}',
    },
    stale: false,
  }
  const transact = vi.fn(async () => {})
  const session: { run?: { id: string } } = {}
  const run = vi.fn(async () => {
    session.run = { id: crypto.randomUUID() }
  })
  const studio = {
    all: new Map([[revision.uri, session]]),
    command: () => ({ dispose() {} }),
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
  it('reports a failed edit without allowing it to be replayed', async () => {
    const { revision, proposals, transact } = fixture()
    const action = proposals.edit(
      revision,
      [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'new' }],
      [{ offset: 9, length: 3, text: 'new' }],
    )
    transact.mockRejectedValueOnce(new Error('Document changed while applying.'))
    await expect(proposals.approve(action.action)).rejects.toThrow(/Document changed/)
    expect(proposals.status(action.action)).toMatchObject({
      status: 'failed',
      message: 'Document changed while applying.',
    })
    await expect(proposals.approve(action.action)).rejects.toThrow(/applied or discarded/)
    expect(transact).toHaveBeenCalledTimes(1)
    proposals.dispose()
  })
  it('does not report a cancelled launch as a started simulation', async () => {
    const { revision, proposals, run } = fixture()
    run.mockImplementationOnce(async () => {})
    const action = proposals.run(
      {
        ...revision,
        values: {},
        outputs: [],
        gridkit: { path: '', image: '', cli: '' },
        cacheBytes: 0,
      },
      {},
    )
    await expect(proposals.approve(action.action)).rejects.toThrow(/before a new run started/)
    expect(proposals.status(action.action).status).toBe('failed')
    proposals.dispose()
  })
  it('previews without writing or asking, captures values, and applies an approval once', async () => {
    const { revision, proposals, transact } = fixture()
    const changes: Mutation[] = [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'new' }]
    const proposed = proposals.edit(revision, changes, [{ offset: 9, length: 3, text: 'new' }])
    expect(proposals.status(proposed.action).status).toBe('pending')
    expect(JSON.parse(proposals.get(proposed.proposal).after)).toEqual({
      changes: [{ line: 1, source: '{"name":"new"}' }],
    })
    changes[0] = { kind: 'set', id: 'Bus/1', field: 'name', value: 'changed after preview' }
    await proposals.review(proposed.proposal)
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.stringContaining('revision 1'),
      { preview: false },
    )
    // The preview's title bar approves; reviewing asks nothing and writes nothing.
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
    expect(transact).not.toHaveBeenCalled()
    await proposals.approve(proposed.proposal)
    expect(transact).toHaveBeenCalledWith(
      revision.uri,
      1,
      [{ kind: 'set', id: 'Bus/1', field: 'name', value: 'new' }],
      'Apply AI changes',
    )
    await expect(proposals.approve(proposed.proposal)).rejects.toThrow(/applied or discarded/)
    expect(transact).toHaveBeenCalledTimes(1)
    expect(proposals.status(proposed.action).status).toBe('applied')
    proposals.dispose()
  })
  it('refuses changed or discarded proposals and never silently retargets an approved run', async () => {
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
    await proposals.approve(first.proposal)
    expect(proposals.status(first.action).status).toBe('started')
    expect(run).toHaveBeenCalledWith(
      revision.uri,
      expect.objectContaining({
        values: { tmax: 1 },
        gridkit: { path: 'captured', image: '', cli: '' },
      }),
    )
    const stale = proposals.run(request, {})
    entry.document.version = 2
    await expect(proposals.approve(stale.proposal)).rejects.toThrow(/case changed/)
    expect(proposals.status(stale.action).status).toBe('stale')
    expect(run).toHaveBeenCalledTimes(1)
    entry.document.version = 1
    const discarded = proposals.run(request, {})
    await proposals.discard(discarded.proposal)
    expect(proposals.status(discarded.action).status).toBe('discarded')
    await expect(proposals.approve(discarded.proposal)).rejects.toThrow(/applied or discarded/)
    // A proposal waits as long as the user takes to look at it.
    const later = proposals.run(request, {})
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60_000)
    expect(proposals.get(later.proposal).kind).toBe('run')
    expect(proposals.status(later.action).status).toBe('pending')
    proposals.dispose()
  })
})
