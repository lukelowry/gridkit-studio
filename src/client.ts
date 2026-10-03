import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { DataBatch } from '@latkit/model'
import { EventEmitter, type ExtensionContext } from 'vscode'

import { terminateRuntime } from './gridkit/runtime.js'
import type { FromWorker, Method, Requests, RuntimeProcess } from './messages.js'

export class Client {
  #worker?: Worker
  #next = 0
  #disposed = false
  #owned = new Map<string, RuntimeProcess>()
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
    const worker = (this.#worker = new Worker(
      join(this.context.extensionPath, 'dist', 'worker.cjs'),
      { workerData: { scratch: join(this.context.globalStorageUri.fsPath, 'runs') } },
    ))
    const failed = (error: Error) => {
      if (this.#worker !== worker) return
      this.#worker = undefined
      for (const entry of this.#pending.values()) {
        entry.cleanup()
        entry.reject(error)
      }
      this.#pending.clear()
      this.failure.fire(error)
      this.#cleanup = Promise.all([...this.#owned.values()].map(terminateRuntime))
        .then(async () => {
          await worker.terminate()
        })
        .finally(() => {
          this.#owned.clear()
          this.#cleanup = undefined
        })
    }
    worker.on('error', failed)
    worker.on('exit', (code) => {
      if (this.#worker === worker)
        failed(new Error(`Data worker stopped (${code}). Reopen or retry the case.`))
    })
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
            Object.assign(new Error(message.message), {
              offset: message.offset,
              length: message.length,
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
