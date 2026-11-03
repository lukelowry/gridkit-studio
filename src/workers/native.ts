import { readFile } from 'node:fs/promises'

import { load } from 'latkit'

let loading: Promise<void> | undefined

/** latkit's module, compiled once per worker from `wasmPath` and shared by every request; a load
 *  that fails is tried again by the next. */
export function loadNative(wasmPath: string): Promise<void> {
  return (loading ??= (async () => {
    const bytes = await readFile(wasmPath)
    const wasm = await WebAssembly.compile(bytes)
    await load({ wasm })
  })().catch((error: unknown) => {
    loading = undefined
    throw error
  }))
}
