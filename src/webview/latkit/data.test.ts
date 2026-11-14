import { createRequire } from 'node:module'

import { Patch } from 'latkit'
import { beforeAll, expect, it, vi } from 'vitest'

import { loadNative } from '../../workers/native.js'
import { DatasetSlot } from './data.js'

// The page's channel to the extension, which only a webview has.
vi.mock('../bridge.js', () => ({ bridge: {} }))

const signal = AbortSignal.any([])

beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))

async function* patches(...values: Uint8Array[]) {
  yield* values
}

it('keeps the complete displayed revision on failure, cancellation, and late completion', async () => {
  const slot = new DatasetSlot()
  const first = new Patch('case').replace('Bus', [1], { v: [1] }).toBytes()
  try {
    await slot.receive('case', 'a', patches(first), signal)
    await expect(slot.receive('case', 'b', patches(Uint8Array.of(1, 2)), signal)).rejects.toThrow()
    expect(slot.current?.key).toBe('a')
    let resolve!: () => void
    const wait = new Promise<void>((done) => {
      resolve = done
    })
    async function* delayed() {
      await wait
      yield first
    }
    const old = slot.receive('case', 'late', delayed(), signal)
    await slot.receive(
      'case',
      'c',
      patches(new Patch('case').replace('Bus', [1], { v: [3] }).toBytes()),
      signal,
    )
    resolve()
    expect(await old).toBe(false)
    expect(slot.current?.key).toBe('c')
    expect(slot.current?.data.get('Bus', 1, 'v')).toBe(3)
    const abort = new AbortController()
    abort.abort()
    await expect(slot.receive('case', 'd', patches(first), abort.signal)).rejects.toThrow()
    expect(slot.current?.key).toBe('c')
  } finally {
    slot.clear()
  }
})
