/** One isolated WASM worker per run. Output goes straight to disk, not through a message queue. */
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
  /** Set to ask GridKit to stop. At its next write or print it unwinds, and the worker closes its
   *  files and exits. Undefined when memory cannot be shared with the worker. */
  readonly stop?: Int32Array<SharedArrayBuffer>
}

export type WasmEvent =
  | { readonly kind: 'output' }
  | { readonly kind: 'log'; readonly text: string }
  | { readonly kind: 'exit'; readonly status: number; readonly message?: string }

const loaded = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()

const STOP_MS = 5000

/** Cache bytes, not compiled modules: sharing modules across short-lived workers crashes
 *  Electron on Windows. Each solver worker owns its compiled code and memory. */
export function solverBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  let pending = loaded.get(path)
  if (!pending) {
    pending = readFile(path).then((bytes) => {
      if (!WebAssembly.validate(bytes)) throw new Error('The included GridKit solver is damaged.')
      return bytes
    })
    loaded.set(path, pending)
    void pending.catch(() => loaded.delete(path))
  }
  return pending
}

/** In a browser, memory can be shared only when the page is cross-origin isolated. */
const shared = () =>
  typeof SharedArrayBuffer === 'function' &&
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false

export async function launchWasm(
  request: RunRequest,
  assets: WasmAssets,
  { signal, log, lifecycle = () => {} }: Launch,
) {
  signal.throwIfAborted()
  const wasm = await solverBytes(assets.wasm)
  signal.throwIfAborted()
  const stopping = shared() ? new Int32Array(new SharedArrayBuffer(4)) : undefined
  const worker = new Worker(assets.worker, {
    execArgv: [],
    workerData: {
      request,
      module: assets.module,
      wasm,
      ...(stopping && { stop: stopping }),
    } satisfies WasmInput,
  })
  let writer: 'writing' | 'done' | 'stopped' = 'writing'
  let ended: Extract<WasmEvent, { kind: 'exit' }> | undefined
  /** Whether GridKit has opened its output, and whether the worker has exited. */
  let writing = false
  let exited = false
  let opened!: () => void
  let refused!: (error: unknown) => void
  const started = new Promise<void>((resolve, reject) => {
    opened = resolve
    refused = reject
  })
  void started.catch(() => {})
  const exit = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
  let stopped: Promise<void> | undefined
  /** Asks a writing GridKit to stop so the worker closes its files, else terminates it. */
  const stop = () =>
    (stopped ??= (async () => {
      if (exited) return
      if (stopping && writing) {
        Atomics.store(stopping, 0, 1)
        // GridKit may catch the unwind and keep computing without writing, so the wait is bounded.
        let timer: ReturnType<typeof setTimeout> | undefined
        const backstop = new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_MS)))
        await Promise.race([exit, backstop])
        clearTimeout(timer)
        if (!exited) await worker.terminate()
      } else await worker.terminate()
    })())
  const abort = () => {
    void stop()
  }
  const done = new Promise<void>((resolve, reject) => {
    worker.on('message', (event: WasmEvent) => {
      if (event.kind === 'log') log(event.text)
      else if (event.kind === 'output') {
        writing = true
        opened()
      } else ended = event
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      exited = true
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
