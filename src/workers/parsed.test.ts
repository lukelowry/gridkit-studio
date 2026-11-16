import { describe, expect, it, vi } from 'vitest'

import { Case } from '../gridkit/case.js'
import { catalog } from '../gridkit/definition.js'
import { diagnose } from '../gridkit/issues.js'
import { summarize } from './parsed.js'

const text = '{"buses":[{"class":"Bus","number":1,"name":"one","params":{"kv":230}}]}'
const signal = () => new AbortController().signal
const parse = (content: string, signal?: AbortSignal) =>
  Case.parse(new TextEncoder().encode(content), catalog, { signal })

describe('indexed case opening', () => {
  it('publishes metadata and selected columns without decoding unrelated values', async () => {
    const kase = await parse(text)
    const kv = kase.table('Bus').fields.get('params.kv')!
    const decoding = vi.spyOn(kv, 'chunks', 'get')
    expect((await summarize(kase, { uri: 'file:///one', version: 1 })).counts.Bus).toBe(1)
    const data = kase.columns().tables.get('Bus')!
    const names = data.read('name', 0, 1)
    expect(names).toEqual(['one'])
    expect(decoding).not.toHaveBeenCalled()
    // Diagnostics are computed once, and check an unread number from its bytes without decoding.
    const issues = await diagnose(kase, signal())
    expect(await diagnose(kase, signal())).toBe(issues)
    expect(decoding).not.toHaveBeenCalled()
    const values = data.read('params.kv', 0, 1)
    expect(values).toEqual(Float64Array.of(230))
    expect(decoding).toHaveBeenCalled()
    expect(data.read('name', 0, 1)).toEqual(names)
  })

  it('cancellation applies to parses and validation, without poisoning later reads', async () => {
    const kase = await parse(text, signal())
    const controller = new AbortController()
    controller.abort(new Error('superseded'))
    await expect(parse(text, controller.signal)).rejects.toThrow('superseded')
    await expect(diagnose(kase, controller.signal)).rejects.toThrow('superseded')
    expect(await diagnose(kase, signal())).toEqual(await diagnose(await parse(text), signal()))
  })
})
