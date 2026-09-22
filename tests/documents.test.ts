import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { Documents } from '../src/documents.js'
import { caseText } from './support/case.js'
import { inlineParser } from './support/parser.js'
import { events, languages, workspace } from './support/vscode.js'

function document(path = '/test.case.json', text = caseText({ buses: [{ number: 1 }] })) {
  return {
    uri: { path },
    version: 1,
    languageId: 'json',
    isClosed: false,
    getText: vi.fn(() => text),
    positionAt: (character: number) => ({ line: 0, character }),
  } as unknown as vscode.TextDocument
}
function change(doc: vscode.TextDocument, text: string) {
  Object.assign(doc, { version: doc.version + 1, getText: vi.fn(() => text) })
  events.change.fire({
    document: doc,
    contentChanges: [{}],
  } as unknown as vscode.TextDocumentChangeEvent)
}

let documents: Documents
let diagnostics: ReturnType<typeof languages.createDiagnosticCollection>
beforeEach(() => {
  vi.useFakeTimers()
  diagnostics = languages.createDiagnosticCollection()
  vi.spyOn(languages, 'createDiagnosticCollection').mockReturnValue(diagnostics)
  documents = new Documents(inlineParser)
})
afterEach(() => {
  documents.dispose()
  workspace.textDocuments.length = 0
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('case documents', () => {
  it('shares the parsed snapshot and source index until the document changes', async () => {
    const doc = document()
    events.open.fire(doc)
    const first = await documents.ensureParsed(doc)
    expect(doc.getText).toHaveBeenCalledTimes(1)
    expect(await documents.ensureParsed(doc)).toBe(first)
    const source = await documents.source(doc, { classId: 'bus', index: 0 })
    expect(await documents.source(doc, { classId: 'bus', index: 0 })).toBe(source)
    expect(doc.getText).toHaveBeenCalledTimes(1)
    change(doc, caseText({ buses: [{ number: 2, name: 'Changed bus' }] }))
    expect(await documents.ensureParsed(doc)).not.toBe(first)
    const next = (await documents.source(doc, { classId: 'bus', index: 0 }))!
    expect(doc.getText().slice(next.offset, next.offset + next.length)).toContain('Changed bus')
  })

  it('publishes pending immediately and validates only the latest edit after the debounce', async () => {
    const doc = document()
    const changed = vi.fn()
    documents.onDidChange(changed)
    events.open.fire(doc)
    change(doc, 'invalid')
    expect(changed.mock.lastCall?.[0].snapshot).toEqual({ version: 2, state: 'pending' })
    await vi.advanceTimersByTimeAsync(100)
    expect(doc.getText).not.toHaveBeenCalled()
    change(doc, caseText({ header: { case_name: 'Latest edit' } }))
    await vi.advanceTimersByTimeAsync(150)
    expect(changed.mock.lastCall?.[0].snapshot).toMatchObject({
      version: 3,
      state: 'valid',
      case: { model: { name: 'Latest edit' } },
    })
    expect(doc.getText).toHaveBeenCalledTimes(1)
  })

  it('cancels scheduled work on close and does not reuse a reopened document version', async () => {
    const doc = document()
    events.open.fire(doc)
    change(doc, 'invalid')
    Object.assign(doc, { isClosed: true })
    events.close.fire(doc)
    await vi.runAllTimersAsync()
    expect(doc.getText).not.toHaveBeenCalled()
    expect(diagnostics.delete).toHaveBeenCalledWith(doc.uri)
    const reopened = document(doc.uri.path, caseText({ header: { case_name: 'Reopened' } }))
    expect(await documents.ensureParsed(reopened)).toMatchObject({
      version: 1,
      case: { model: { name: 'Reopened' } },
    })
  })

  it('keeps resources with matching paths and versions independent', async () => {
    const one = document('/shared.case.json')
    const two = document('/shared.case.json', caseText({ header: { case_name: 'Remote case' } }))
    Object.assign(two, { uri: { path: two.uri.path, scheme: 'remote', authority: 'server' } })
    expect(await documents.ensureParsed(one)).not.toBe(await documents.ensureParsed(two))
    expect(await documents.ensureParsed(two)).toMatchObject({
      case: { model: { name: 'Remote case' } },
    })
  })

  it('leaves JSON syntax diagnostics to VS Code while enforcing strict JSON in JSONC', async () => {
    const doc = document('/test.case.json', '{/* comment */}')
    expect((await documents.ensureParsed(doc)).state).toBe('invalid')
    expect(diagnostics.set).toHaveBeenLastCalledWith(doc.uri, [])
    const jsonc = document('/strict.case.json', '{/* comment */}')
    Object.assign(jsonc, { languageId: 'jsonc' })
    await documents.ensureParsed(jsonc)
    expect(diagnostics.set.mock.lastCall?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'GridKit',
          message: expect.stringContaining('Invalid JSON'),
        }),
      ]),
    )
  })

  it('ignores unrelated changes and releases listeners and timers on disposal', async () => {
    const doc = document()
    const other = document('/settings.json')
    events.open.fire(other)
    expect(other.getText).not.toHaveBeenCalled()
    events.change.fire({
      document: doc,
      contentChanges: [],
    } as unknown as vscode.TextDocumentChangeEvent)
    expect(doc.getText).not.toHaveBeenCalled()
    change(doc, 'invalid')
    documents.dispose()
    await vi.runAllTimersAsync()
    events.open.fire(doc)
    expect(doc.getText).not.toHaveBeenCalled()
  })
})

it('accepts integral fault parameters without reporting formatting as an error', async () => {
  const doc = document(
    '/fault.case.json',
    caseText({
      buses: [{ number: 1 }],
      devices: [{ class: 'BusFault', ports: { bus: 1 }, params: { R: 0, X: 1, state0: false } }],
    }),
  )
  events.open.fire(doc)
  expect((await documents.ensureParsed(doc)).state).toBe('valid')
  expect(diagnostics.set.mock.lastCall?.[1]).toEqual([])
})

it('discards a late valid result after an edit and a late invalid result after close', async () => {
  documents.dispose()
  const pending: {
    text: string
    signal: AbortSignal
    finish(value: Awaited<ReturnType<typeof inlineParser.parse>>): void
  }[] = []
  documents = new Documents({
    parse: (text, signal) => new Promise((finish) => pending.push({ text, signal, finish })),
    dispose() {},
  })
  const doc = document()
  const first = documents.ensureParsed(doc)
  const stale = expect(first).rejects.toThrow('changed')
  change(doc, caseText({ header: { case_name: 'Current' } }))
  const second = documents.ensureParsed(doc)
  const newer = await inlineParser.parse(pending[1].text, new AbortController().signal)
  pending[1].finish(newer)
  expect(await second).toMatchObject({ version: 2, state: 'valid' })
  const older = await inlineParser.parse(pending[0].text, new AbortController().signal)
  if (older.state !== 'valid') throw new Error('Invalid fixture')
  const release = vi.spyOn(older, 'dispose')
  pending[0].finish(older)
  await stale
  expect(release).toHaveBeenCalledOnce()
  expect(documents.current(doc)).toMatchObject({ version: 2, case: { model: { name: 'Current' } } })
  change(doc, '{ broken')
  const closing = documents.ensureParsed(doc)
  const rejected = expect(closing).rejects.toThrow('changed')
  Object.assign(doc, { isClosed: true })
  events.close.fire(doc)
  pending[2].finish({
    state: 'invalid',
    issues: [{ offset: 0, length: 1, message: 'late failure' }],
  })
  await rejected
  expect(diagnostics.set.mock.lastCall?.[1]).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ message: 'late failure' })]),
  )
})

it('rechecks an explicit newer revision even when the change event has no content edits', async () => {
  const doc = document()
  await documents.ensureParsed(doc)
  Object.assign(doc, { version: 2 })
  events.change.fire({
    document: doc,
    contentChanges: [],
  } as unknown as vscode.TextDocumentChangeEvent)
  expect(await documents.ensureParsed(doc, 2)).toMatchObject({ version: 2, state: 'valid' })
  await expect(documents.ensureParsed(doc, 1)).rejects.toThrow('changed')
})
