import { load } from 'latkit'

import { readFile } from '../platform/files.js'
import { browser } from '../platform/host.js'
import { dirname, join } from '../platform/path.js'

let loading: Promise<void> | undefined

/** Compiles latkit's module from `wasmPath` once per worker. A failed load is retried on the next
 *  call. The workers give latkit no jobs, so Node needs no more than the module. A browser worker
 *  runs from a blob, which latkit's own asset URLs cannot be resolved against, so there it names
 *  the jobs module and the worker beside the module too. */
export function loadNative(wasmPath: string): Promise<void> {
  return (loading ??= (async () => {
    const beside = (file: string) => readFile(join(dirname(wasmPath), file))
    const wasm = await WebAssembly.compile(await readFile(wasmPath))
    const assets = browser
      ? {
          jobs: await WebAssembly.compile(await beside('latkit-jobs.wasm')),
          worker: await beside('latkit-worker.js').then((source) => {
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
