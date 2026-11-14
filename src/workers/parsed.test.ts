import { describe, expect, it, vi } from 'vitest'

import { Case } from '../gridkit/case.js'
import { catalog } from '../gridkit/definition.js'
import { diagnose } from '../gridkit/issues.js'
import { Recent, summarize } from './parsed.js'

const text = '{"buses":[{"class":"Bus","number":1,"name":"one","params":{"kv":230}}]}'
const signal = () => new AbortController().signal
/** The case `content` holds, read as a file of it reads. */
const parse = (content: string, signal?: AbortSignal) =>
  Case.parse(new TextEncoder().encode(content), catalog, { signal })

describe('indexed case opening', () => {
  it('publishes metadata and selected columns without decoding unrelated values', async () => {
    const kase = await parse(text)
    const kv = kase.table('Bus').fields.get('params.kv')!
    const decoding = vi.spyOn(kv, 'chunks', 'get')
    expect((await summarize(kase, { uri: 'file:///one', version: 1 })).counts.Bus).toBe(1)
    const data = kase.projected().tables.get('Bus')!
    const names = data.read('name', 0, 1)
    expect(names).toEqual(['one'])
    expect(decoding).not.toHaveBeenCalled()
    // What is wrong with it is found once, and a number nobody reads is checked where it is
    // written, undecoded still.
    const issues = await diagnose(kase, signal())
    expect(await diagnose(kase, signal())).toBe(issues)
    expect(decoding).not.toHaveBeenCalled()
    const values = data.read('params.kv', 0, 1)
    expect(values).toEqual(Float64Array.of(230))
    expect(decoding).toHaveBeenCalled()
    expect(data.read('name', 0, 1)).toEqual(names)
  })

  it('keeps cases of files let go of by their URI, the least recently let go of going first', async () => {
    const kase = await parse(text)
    const recent = new Recent<{ kase: Case }>()
    const kept = { kase }
    recent.keep('a', kept)
    expect(recent.take('a')).toBe(kept)
    // Taken, it is kept no more.
    expect(recent.take('a')).toBeUndefined()
    // More let go of than it keeps: those kept are the last let go of, and the first went.
    const uris = Array.from({ length: 100 }, (_, at) => 'file:///' + at)
    for (const uri of uris) recent.keep(uri, { kase })
    const held = uris.map((uri) => recent.take(uri) !== undefined)
    expect(held[0]).toBe(false)
    expect(held.at(-1)).toBe(true)
    expect(held.indexOf(true)).toBe(held.lastIndexOf(false) + 1)
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
