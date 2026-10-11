import { describe, expect, it, vi } from 'vitest'

import { Case } from '../gridkit/case.js'
import { catalog, catalogOf } from '../gridkit/definition.js'
import { diagnose, diagnoseAsync } from '../gridkit/edits.js'
import { CaseCache, summarize, TextCases } from './parsed.js'

const text = '{"buses":[{"class":"Bus","number":1,"name":"one","params":{"kv":230}}]}'
const signal = () => new AbortController().signal

describe('indexed case opening', () => {
  it('publishes metadata and selected columns without decoding unrelated values', async () => {
    const kase = await Case.parse(text, catalog)
    const kv = kase.table('Bus').fields.get('params.kv')!
    const decoding = vi.spyOn(kv, 'chunks', 'get')
    expect(summarize(kase, { uri: 'file:///one', version: 1 }).validation).toBe('pending')
    const data = kase.data
    const names = data.tables.Bus!.fields.name!
    expect(names.length).toBeGreaterThan(0)
    expect(decoding).not.toHaveBeenCalled()
    const values = data.tables.Bus!.fields['params.kv']!
    expect(values).toBe(data.tables.Bus!.fields['params.kv'])
    expect(decoding).toHaveBeenCalled()
    const issues = await diagnoseAsync(kase, signal())
    expect(diagnose(kase)).toBe(issues)
    expect(kase.data).toBe(data)
    expect(data.tables.Bus!.fields.name).toBe(names)
  })

  it("finds each document's latest case while its content is the same, however large", async () => {
    const cache = new CaseCache()
    const first = await cache.parse('file:///one', text, catalog, 'one', signal())
    expect(cache.find('file:///one', first.version)).toBe(first)
    expect(cache.find('file:///two', first.version)).toBeUndefined()
    const changed = await cache.parse(
      'file:///one',
      text.replace('230', '115'),
      catalog,
      'one',
      signal(),
    )
    expect(cache.find('file:///one', first.version)).toBeUndefined()
    expect(cache.find('file:///one', changed.version)).toBe(changed)
    // Another catalog reads the same text as other content.
    const revised = catalogOf({ ...JSON.parse(catalog.text), revision: 2 })
    const again = await cache.parse('file:///one', text, revised, 'one', signal())
    expect(again.version).not.toBe(first.version)
    cache.forget('file:///one')
    expect(cache.find('file:///one', again.version)).toBeUndefined()
  })

  it('finds a whole text read before by its hash, and keeps no case past its budget', async () => {
    const kase = await Case.parse(text, catalog, 'one')
    const key = TextCases.key(text, catalog, 'one')
    expect(key).not.toBe(TextCases.key(text, catalog, 'two'))
    const cases = new TextCases()
    cases.keep(kase, () => key)
    expect(cases.find(key)).toBe(kase)
    const asked = vi.fn(() => key)
    const none = new TextCases(0)
    none.keep(kase, asked)
    expect(none.find(key)).toBeUndefined()
    // A case past the budget is never hashed to be kept.
    expect(asked).not.toHaveBeenCalled()
    const one = new TextCases(1 << 20, 1)
    one.keep(kase, () => 'first')
    one.keep(kase, () => 'second')
    expect(one.find('first')).toBeUndefined()
    expect(one.find('second')).toBe(kase)
  })

  it('cancellation applies to parses and validation, without poisoning later reads', async () => {
    const cache = new CaseCache()
    const kase = await cache.parse('file:///one', text, catalog, 'one', signal())
    const controller = new AbortController()
    controller.abort(new Error('superseded'))
    await expect(
      cache.parse('file:///one', text, catalog, 'one', controller.signal),
    ).rejects.toThrow('superseded')
    await expect(diagnoseAsync(kase, controller.signal)).rejects.toThrow('superseded')
    expect(await diagnoseAsync(kase, signal())).toEqual(diagnose(kase))
  })
})
