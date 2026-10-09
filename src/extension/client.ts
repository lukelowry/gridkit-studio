import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { type CancellationToken, EventEmitter, type ExtensionContext } from 'vscode'

import { terminateRuntime } from '../gridkit/index.js'
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
      cleanup(): void
    }
  >()
  readonly event = new EventEmitter<Extract<FromWorker, { kind: 'run' | 'log' }>>()
  readonly failure = new EventEmitter<Error>()
  constructor(private readonly context: ExtensionContext) {}
  #get() {
    if (this.#worker) return this.#worker
    const worker = (this.#worker = new Worker(
      join(this.context.extensionPath, 'dist', 'worker.cjs'),
    ))
    const failed = (error: Error) => {
      if (this.#worker !== worker) return
      this.#worker = undefined
      // Set before anyone hears of the failure, so a call it prompts waits for the teardown.
      const owned = [...this.#owned.values()]
      this.#owned.clear()
      this.#cleanup = Promise.all(owned.map(terminateRuntime))
        .then(() => worker.terminate())
        .then(() => {})
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
    })
    return worker
  }
  call<K extends Method>(
    method: K,
    input: Requests[K]['input'],
    signal?: AbortSignal,
  ): Promise<Requests[K]['output']> {
    if (this.#disposed) return Promise.reject(new Error('Studio is closed.'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.#cleanup) return this.#cleanup.then(() => this.call(method, input, signal))
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
    this.event.dispose()
    this.failure.dispose()
  }
}
