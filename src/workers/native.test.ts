import { createRequire } from 'node:module'

import { expect, it } from 'vitest'

import { loadNative } from './native.js'

it('loads latkit once, and again after a load that failed', async () => {
  const wasm = createRequire(import.meta.url).resolve('latkit/wasm')
  await expect(loadNative(wasm + '.missing')).rejects.toThrow()
  const first = loadNative(wasm)
  expect(loadNative(wasm)).toBe(first)
  await first
})
