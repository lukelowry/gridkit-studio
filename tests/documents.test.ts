import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { Documents } from '../src/documents.js'
import { caseText } from './support/case.js'
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
  documents = new Documents()
})
afterEach(() => {
  documents.dispose()
  workspace.textDocuments.length = 0
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('case documents', () => {
  it('shares the parsed snapshot and source index until the document changes', () => {
    const doc = document()
    events.open.fire(doc)
    const first = documents.read(doc)
    expect(doc.getText).toHaveBeenCalledTimes(1)
    expect(documents.read(doc)).toBe(first)
    const source = documents.source(doc, { classId: 'bus', index: 0 })
    expect(documents.source(doc, { classId: 'bus', index: 0 })).toBe(source)
    expect(doc.getText).toHaveBeenCalledTimes(2)
    change(doc, caseText({ buses: [{ number: 2, name: 'Changed bus' }] }))
    expect(documents.read(doc)).not.toBe(first)
    const next = documents.source(doc, { classId: 'bus', index: 0 })!
    expect(doc.getText().slice(next.offset, next.offset + next.length)).toContain('Changed bus')
  })

  it('publishes pending immediately and validates only the latest edit after the debounce', () => {
    const doc = document()
    const changed = vi.fn()
    documents.onDidChange(changed)
    events.open.fire(doc)
    change(doc, 'invalid')
    expect(changed.mock.lastCall?.[0].snapshot).toEqual({ version: 2, state: 'pending' })
    vi.advanceTimersByTime(100)
    expect(doc.getText).not.toHaveBeenCalled()
    change(doc, caseText({ header: { case_name: 'Latest edit' } }))
    vi.advanceTimersByTime(150)
    expect(changed.mock.lastCall?.[0].snapshot).toMatchObject({
      version: 3,
      state: 'valid',
      case: { model: { name: 'Latest edit' } },
    })
    expect(doc.getText).toHaveBeenCalledTimes(1)
  })

  it('cancels scheduled work on close and does not reuse a reopened document version', () => {
    const doc = document()
    events.open.fire(doc)
    change(doc, 'invalid')
    Object.assign(doc, { isClosed: true })
    events.close.fire(doc)
    vi.runAllTimers()
    expect(doc.getText).not.toHaveBeenCalled()
    expect(diagnostics.delete).toHaveBeenCalledWith(doc.uri)
    const reopened = document(doc.uri.path, caseText({ header: { case_name: 'Reopened' } }))
    expect(documents.read(reopened)).toMatchObject({
      version: 1,
      case: { model: { name: 'Reopened' } },
    })
  })

  it('keeps resources with matching paths and versions independent', () => {
    const one = document('/shared.case.json')
    const two = document('/shared.case.json', caseText({ header: { case_name: 'Remote case' } }))
    Object.assign(two, { uri: { path: two.uri.path, scheme: 'remote', authority: 'server' } })
    expect(documents.read(one)).not.toBe(documents.read(two))
    expect(documents.read(two)).toMatchObject({ case: { model: { name: 'Remote case' } } })
  })

  it('leaves JSON syntax diagnostics to VS Code while enforcing strict JSON in JSONC', () => {
    const doc = document('/test.case.json', '{/* comment */}')
    expect(documents.read(doc).state).toBe('invalid')
    expect(diagnostics.set).toHaveBeenLastCalledWith(doc.uri, [])
    const jsonc = document('/strict.case.json', '{/* comment */}')
    Object.assign(jsonc, { languageId: 'jsonc' })
    documents.read(jsonc)
    expect(diagnostics.set.mock.lastCall?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'GridKit',
          message: expect.stringContaining('Invalid JSON'),
        }),
      ]),
    )
  })

  it('ignores unrelated changes and releases listeners and timers on disposal', () => {
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
    vi.runAllTimers()
    events.open.fire(doc)
    expect(doc.getText).not.toHaveBeenCalled()
  })
})

it('accepts integral fault parameters without reporting formatting as an error', () => {
  const doc = document(
    '/fault.case.json',
    caseText({
      buses: [{ number: 1 }],
      devices: [{ class: 'BusFault', ports: { bus: 1 }, params: { R: 0, X: 1, state0: false } }],
    }),
  )
  events.open.fire(doc)
  expect(documents.read(doc).state).toBe('valid')
  expect(diagnostics.set.mock.lastCall?.[1]).toEqual([])
})
