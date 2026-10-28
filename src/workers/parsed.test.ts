import { describe, expect, it, vi } from 'vitest'

import { Case } from '../gridkit/case.js'
import { catalog, catalogOf } from '../gridkit/definition.js'
import { diagnose } from '../gridkit/edits.js'
import { summarize, TextCases } from './parsed.js'

const text = '{"buses":[{"class":"Bus","number":1,"name":"one","params":{"kv":230}}]}'
const signal = () => new AbortController().signal

describe('indexed case opening', () => {
  it('publishes metadata and selected columns without decoding unrelated values', async () => {
    const kase = await Case.parse(text, catalog)
    const kv = kase.table('Bus').fields.get('params.kv')!
    const decoding = vi.spyOn(kv, 'chunks', 'get')
    expect((await summarize(kase, { uri: 'file:///one', version: 1 })).validation).toBe('pending')
    const data = kase.projected().tables.get('Bus')!
    const names = data.read('name', 0, 1)
    expect(names).toEqual(['one'])
    expect(decoding).not.toHaveBeenCalled()
    const values = data.read('params.kv', 0, 1)
    expect(values).toEqual(Float64Array.of(230))
    expect(decoding).toHaveBeenCalled()
    const issues = await diagnose(kase, signal())
    expect(await diagnose(kase, signal())).toBe(issues)
    expect(data.read('name', 0, 1)).toEqual(names)
  })

  it('names content apart: an edit, or another catalog, reads as other content', async () => {
    const first = await Case.parse(text, catalog, 'one')
    expect((await Case.parse(text, catalog, 'one')).version).toBe(first.version)
    const changed = await Case.parse(text.replace('230', '115'), catalog, 'one')
    expect(changed.version).not.toBe(first.version)
    const revised = catalogOf({ ...JSON.parse(catalog.text), revision: 2 })
    expect((await Case.parse(text, revised, 'one')).version).not.toBe(first.version)
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
    const kase = await Case.parse(text, catalog, 'one', signal())
    const controller = new AbortController()
    controller.abort(new Error('superseded'))
    await expect(Case.parse(text, catalog, 'one', controller.signal)).rejects.toThrow('superseded')
    await expect(diagnose(kase, controller.signal)).rejects.toThrow('superseded')
    expect(await diagnose(kase, signal())).toEqual(
      await diagnose(await Case.parse(text, catalog), signal()),
    )
  })
})
