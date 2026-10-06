import { describe, expect, it, vi } from 'vitest'

import { Case } from '../gridkit/case.js'
import { catalog, catalogOf } from '../gridkit/definition.js'
import { diagnose, diagnoseAsync } from '../gridkit/edits.js'
import { CaseCache, summarize } from './cases.js'

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

  it('reuses only identical source, catalog and fallback name, with bounded eviction', async () => {
    const cache = new CaseCache(1 << 20, 1)
    const first = await cache.parse(text, catalog, 'one', signal())
    expect(await cache.parse(text, catalog, 'one', signal())).toBe(first)
    const changed = text.replace('230', '115')
    expect(await cache.parse(changed, catalog, 'one', signal())).not.toBe(first)
    expect(await cache.parse(text, catalog, 'one', signal())).not.toBe(first)
    const current = await cache.parse(text, catalog, 'one', signal())
    expect(await cache.parse(text, catalog, 'two', signal())).not.toBe(current)
    const second = await cache.parse(text, catalog, 'two', signal())
    const revisedCatalog = catalogOf({ ...JSON.parse(catalog.text), revision: 2 })
    expect(await cache.parse(text, revisedCatalog, 'two', signal())).not.toBe(second)
    const uncached = new CaseCache(0)
    expect(await uncached.parse(text, catalog, 'one', signal())).not.toBe(
      await uncached.parse(text, catalog, 'one', signal()),
    )
  })

  it('cancellation applies to cache hits and validation, without poisoning later reads', async () => {
    const cache = new CaseCache()
    const kase = await cache.parse(text, catalog, 'one', signal())
    const controller = new AbortController()
    controller.abort(new Error('superseded'))
    await expect(cache.parse(text, catalog, 'one', controller.signal)).rejects.toThrow('superseded')
    await expect(diagnoseAsync(kase, controller.signal)).rejects.toThrow('superseded')
    expect(await diagnoseAsync(kase, signal())).toEqual(diagnose(kase))
  })
})
