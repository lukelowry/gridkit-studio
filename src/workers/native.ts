import { load } from 'latkit'

import { readFile } from '../platform/files.js'
import { browser } from '../platform/host.js'
import { dirname, join } from '../platform/path.js'

let loading: Promise<void> | undefined

/** Compiles latkit's module from `wasmPath` once per worker. A failed load is retried on the next
 *  call. */
export function loadNative(wasmPath: string): Promise<void> {
  return (loading ??= (async () => {
    const bytes = await readFile(wasmPath)
    const wasm = await WebAssembly.compile(bytes)
    const assets = browser
      ? {
          worker: await readFile(join(dirname(wasmPath), 'latkit-worker.js')).then((source) => {
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
            return () => new globalThis.Worker(url)
          }),
        }
      : {}
    await load({ wasm, ...assets })
  })().catch((error: unknown) => {
    loading = undefined
    throw error
  }))
}
