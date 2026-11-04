import { describe, expect, it, vi } from 'vitest'

import { Case } from '../gridkit/case.js'
import { catalog, catalogOf } from '../gridkit/definition.js'
import { diagnose } from '../gridkit/issues.js'
import { Recent, summarize } from './parsed.js'

const text = '{"buses":[{"class":"Bus","number":1,"name":"one","params":{"kv":230}}]}'
const signal = () => new AbortController().signal
/** The case `content` holds, read as a file of it reads. */
const parse = (
  content: string,
  ...rest: [Parameters<typeof Case.parse>[1], string?, AbortSignal?]
) => Case.parse(new TextEncoder().encode(content), ...rest)

describe('indexed case opening', () => {
  it('publishes metadata and selected columns without decoding unrelated values', async () => {
    const kase = await parse(text, catalog)
    const kv = kase.table('Bus').fields.get('params.kv')!
    const decoding = vi.spyOn(kv, 'chunks', 'get')
    expect((await summarize(kase, { uri: 'file:///one', version: 1 })).counts.Bus).toBe(1)
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

  it('names content apart: a change, or another catalog, reads as other content', async () => {
    const first = await parse(text, catalog, 'one')
    expect((await parse(text, catalog, 'one')).version).toBe(first.version)
    const changed = await parse(text.replace('230', '115'), catalog, 'one')
    expect(changed.version).not.toBe(first.version)
    const revised = catalogOf({ ...JSON.parse(catalog.text), revision: 2 })
    expect((await parse(text, revised, 'one')).version).not.toBe(first.version)
  })

  it('keeps cases of files let go of by their URI, the least recently let go of going first', async () => {
    const kase = await parse(text, catalog, 'one')
    const recent = new Recent<{ kase: Case }>()
    const kept = { kase }
    recent.keep('a', kept)
    expect(recent.take('a')).toBe(kept)
    // Taken, it is kept no more.
    expect(recent.take('a')).toBeUndefined()
    for (const uri of ['a', 'b', 'c', 'd', 'e']) recent.keep(uri, { kase })
    expect(recent.take('a')).toBeUndefined()
    expect(recent.take('e')).toBeDefined()
  })

  it('cancellation applies to parses and validation, without poisoning later reads', async () => {
    const kase = await parse(text, catalog, 'one', signal())
    const controller = new AbortController()
    controller.abort(new Error('superseded'))
    await expect(parse(text, catalog, 'one', controller.signal)).rejects.toThrow('superseded')
    await expect(diagnose(kase, controller.signal)).rejects.toThrow('superseded')
    expect(await diagnose(kase, signal())).toEqual(
      await diagnose(await parse(text, catalog), signal()),
    )
  })
})
