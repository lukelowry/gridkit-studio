import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { DataBatch } from '@latkit/model'
import { type CancellationToken, EventEmitter, type ExtensionContext, workspace } from 'vscode'

import { terminateRuntime } from '../gridkit/index.js'
import { scratchFolder, sweep } from '../results/scratch.js'
import type { FromWorker, Method, Requests, RuntimeProcess } from '../shared/messages.js'

/** Run `run` with a signal that aborts when `token` is cancelled. */
export async function cancellable<T>(
  token: CancellationToken | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const subscription = token?.onCancellationRequested(() => controller.abort())
  if (token?.isCancellationRequested) controller.abort()
  try {
    return await run(controller.signal)
  } finally {
    subscription?.dispose()
  }
}

export class Client {
  #worker?: Worker
  /** The folder the worker keeps its runs in, deleted with it. */
  #scratch?: string
  #next = 0
  #disposed = false
  /** The GridKit process the worker runs for each case, terminated here if the worker dies. */
  #owned = new Map<string, RuntimeProcess>()
  /** Pending teardown of a failed worker; calls wait for it before starting another. */
  #cleanup?: Promise<void>
  #pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      consume?(batches: readonly DataBatch[]): Promise<void>
      cleanup(): void
    }
  >()
  readonly event = new EventEmitter<Extract<FromWorker, { kind: 'run' | 'log' }>>()
  readonly failure = new EventEmitter<Error>()
  constructor(private readonly context: ExtensionContext) {}
  #get() {
    if (this.#worker) return this.#worker
    const root = join(this.context.globalStorageUri.fsPath, 'runs')
    const scratch = (this.#scratch = scratchFolder(root))
    // Runs left behind by windows that closed without cleaning up, or by an earlier worker here.
    void sweep(root, scratch)
    const worker = (this.#worker = new Worker(
      join(this.context.extensionPath, 'dist', 'worker.cjs'),
      {
        workerData: {
          scratch,
          storage: join(
            (this.context.storageUri ?? this.context.globalStorageUri).fsPath,
            'results',
          ),
          storageBytes:
            workspace.getConfiguration('gridkitStudio').get<number>('resultStorageMiB', 4096) *
            (1 << 20),
        },
      },
    ))
    const failed = (error: Error) => {
      if (this.#worker !== worker) return
      this.#worker = undefined
      // Set before anyone hears of the failure, so a call it prompts waits for the teardown.
      const owned = [...this.#owned.values()]
      this.#owned.clear()
      this.#cleanup = Promise.all(owned.map(terminateRuntime))
        .then(async () => {
          await worker.terminate()
          await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
        })
        .finally(() => {
          this.#cleanup = undefined
        })
      for (const entry of this.#pending.values()) {
        entry.cleanup()
        entry.reject(error)
      }
      this.#pending.clear()
      this.failure.fire(error)
    }
    worker.on('error', (error) =>
      failed(
        Object.assign(new Error(`The data worker stopped: ${error.message}`), {
          detail: error.stack,
        }),
      ),
    )
    worker.on('exit', (code) => failed(new Error(`The data worker stopped (exit code ${code}).`)))
    worker.on('message', (message: FromWorker) => {
      if (message.kind === 'process') {
        if (message.process) this.#owned.set(message.uri, message.process)
        else this.#owned.delete(message.uri)
        return
      }
      if (message.kind === 'run' || message.kind === 'log') return this.event.fire(message)
      const pending = this.#pending.get(message.id)
      if (!pending) return
      if (message.kind === 'batch') {
        void (pending.consume?.(message.batches) ?? Promise.resolve()).then(
          () => worker.postMessage({ kind: 'ack', id: message.id }),
          (error) => {
            worker.postMessage({ kind: 'cancel', id: message.id })
            pending.reject(error)
            pending.cleanup()
            this.#pending.delete(message.id)
          },
        )
      } else {
        pending.cleanup()
        this.#pending.delete(message.id)
        if (message.kind === 'error')
          pending.reject(
            Object.assign(new Error(message.problem.message), {
              ...message.problem,
              offset: message.offset,
              length: message.length,
              ...(message.defect && { defect: true, detail: message.detail }),
            }),
          )
        else pending.resolve(message.value)
      }
    })
    return worker
  }
  call<K extends Method>(
    method: K,
    input: Requests[K]['input'],
    signal?: AbortSignal,
    consume?: (batches: readonly DataBatch[]) => Promise<void>,
  ): Promise<Requests[K]['output']> {
    if (this.#disposed) return Promise.reject(new Error('Studio is closed.'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.#cleanup) return this.#cleanup.then(() => this.call(method, input, signal, consume))
    const worker = this.#get()
    const id = ++this.#next
    return new Promise((resolve, reject) => {
      const abort = () => {
        worker.postMessage({ kind: 'cancel', id })
        this.#pending.delete(id)
        cleanup()
        reject(signal?.reason ?? new Error('Cancelled'))
      }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      this.#pending.set(id, {
        resolve: (value) => resolve(value as Requests[K]['output']),
        reject,
        consume,
        cleanup,
      })
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ kind: 'request', id, method, input })
    })
  }
  async dispose() {
    if (this.#worker) await this.call('shutdown', {}).catch(() => {})
    this.#disposed = true
    const worker = this.#worker
    this.#worker = undefined
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(new Error('Studio disposed.'))
    }
    this.#pending.clear()
    await Promise.all([...this.#owned.values()].map(terminateRuntime))
    this.#owned.clear()
    await this.#cleanup
    await worker?.terminate()
    // A window's runs end with it.
    if (worker && this.#scratch)
      await rm(this.#scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    this.event.dispose()
    this.failure.dispose()
  }
}
