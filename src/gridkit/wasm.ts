/** One isolated WASM worker per run. Its output goes directly to disk, not an unbounded message queue. */
import { readFile } from '../platform/files.js'
import { Worker } from '../platform/thread.js'
import type { RunRequest } from '../shared/simulation.js'
import type { Launch } from './runtime.js'

export interface WasmAssets {
  readonly worker: string
  readonly module: string
  readonly wasm: string
}

export interface WasmInput {
  readonly request: RunRequest
  readonly module: string
  readonly wasm: Uint8Array<ArrayBuffer>
}

export type WasmEvent =
  | { readonly kind: 'output' }
  | { readonly kind: 'log'; readonly text: string }
  | { readonly kind: 'exit'; readonly status: number; readonly message?: string }

const loaded = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()

/** Cache bytes, not compiled modules: sharing modules across short-lived workers crashes
 *  Electron on Windows. Each solver worker owns its compiled code and memory. */
export function solverBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  let pending = loaded.get(path)
  if (!pending) {
    pending = readFile(path).then((bytes) => {
      if (!WebAssembly.validate(bytes)) throw new Error('Bundled GridKit WebAssembly is invalid.')
      return bytes
    })
    loaded.set(path, pending)
    void pending.catch(() => loaded.delete(path))
  }
  return pending
}

export async function launchWasm(
  request: RunRequest,
  assets: WasmAssets,
  { signal, log, lifecycle = () => {} }: Launch,
) {
  signal.throwIfAborted()
  const wasm = await solverBytes(assets.wasm)
  signal.throwIfAborted()
  const worker = new Worker(assets.worker, {
    execArgv: [],
    workerData: { request, module: assets.module, wasm } satisfies WasmInput,
  })
  let writer: 'writing' | 'done' | 'stopped' = 'writing'
  let termination: Promise<void> | undefined
  let ended: Extract<WasmEvent, { kind: 'exit' }> | undefined
  let opened!: () => void
  let refused!: (error: unknown) => void
  const started = new Promise<void>((resolve, reject) => {
    opened = resolve
    refused = reject
  })
  void started.catch(() => {})
  const stop = () => (termination ??= worker.terminate().then(() => {}))
  const abort = () => {
    void stop()
  }
  const done = new Promise<void>((resolve, reject) => {
    worker.on('message', (event: WasmEvent) => {
      if (event.kind === 'log') log(event.text)
      else if (event.kind === 'output') opened()
      else ended = event
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (signal.aborted) reject(signal.reason)
      else if (code !== 0 || !ended || ended.status !== 0)
        reject(
          new Error(
            ended?.message || `GridKit WebAssembly stopped (exit ${ended?.status ?? code}).`,
          ),
        )
      else {
        writer = 'done'
        resolve()
      }
    })
  }).finally(async () => {
    if (writer === 'writing') writer = 'stopped'
    signal.removeEventListener('abort', abort)
    await stop()
    lifecycle()
  })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  void done.catch(() => {})
  void done.then(() => refused(new Error('GridKit wrote no output.')), refused)
  return { done, started, stop, writer: () => writer }
}
