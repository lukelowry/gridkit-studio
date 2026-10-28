import { readFile } from 'node:fs/promises'

import { load } from 'latkit'

let loading: Promise<void> | undefined
let selected: string | undefined

/** Exactly one compiled module per worker, shared by all concurrent requests. */
export function loadNative(wasmPath: string): Promise<void> {
  if (selected !== undefined && selected !== wasmPath) {
    return Promise.reject(new Error('The worker already selected another WASM asset.'))
  }
  selected = wasmPath
  return (loading ??= (async () => {
    const bytes = await readFile(wasmPath)
    const wasm = await WebAssembly.compile(bytes)
    await load({ wasm })
  })().catch((error: unknown) => {
    loading = undefined
    selected = undefined
    throw error
  }))
}
