import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { type ClassData, createModel, type ElementRef } from '@latkit/model'
import { connect } from '@latkit/port'

import { workerPort } from '../csv/port.js'
import type { ParsedCase } from '../gridkit/parse.js'
import { elementKey, type Issue, type Span } from '../gridkit/source.js'
import { type ParseReply, parserProtocol } from './protocol.js'
export type ParsedDocument =
  | { state: 'invalid'; issues: readonly Issue[] }
  | {
      state: 'valid'
      case: ParsedCase
      source(ref: ElementRef, signal?: AbortSignal): Promise<Span | undefined>
      dispose(): void
    }
export interface CaseParser {
  parse(text: string, signal: AbortSignal): Promise<ParsedDocument>
  dispose(): void
}
function session(path: string) {
  const worker = new Worker(path, { resourceLimits: { maxOldGenerationSizeMb: 512 } })
  return { worker, connection: connect(workerPort(worker), parserProtocol) }
}
export class Parser implements CaseParser {
  private current?: ReturnType<typeof session>
  private pending: {
    text: string
    bytes: number
    signal: AbortSignal
    resolve(value: ParsedDocument): void
    reject(error: unknown): void
    detach(): void
  }[] = []
  private queuedBytes = 0
  private busy = false
  private disposed = false
  constructor(
    private readonly failed: (error: Error) => void,
    private readonly path = join(__dirname, 'parser/worker.cjs'),
  ) {}
  private worker() {
    if (!this.current) {
      const current = (this.current = session(this.path))
      const fail = (error: Error) => {
        if (this.current !== current) return
        this.current = undefined
        current.connection.close()
        void current.worker.terminate()
        this.failed(error)
      }
      current.worker.once('error', fail)
      current.worker.once('exit', (code) =>
        fail(new Error('Case parser worker exited (' + code + '). Reopen the case to retry.')),
      )
    }
    return this.current
  }
  parse(text: string, signal: AbortSignal): Promise<ParsedDocument> {
    signal.throwIfAborted()
    if (this.disposed) return Promise.reject(new Error('The case parser is closed.'))
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > 64 * 1024 * 1024)
      return Promise.reject(new RangeError('Case text exceeds the 64 MiB limit.'))
    if (this.pending.length >= 64 || this.queuedBytes + bytes > 128 * 1024 * 1024)
      return Promise.reject(
        new RangeError(
          'Too many case documents are waiting to parse. Retry after parsing finishes.',
        ),
      )
    return new Promise((resolve, reject) => {
      const job = {
        text,
        bytes,
        signal,
        resolve,
        reject,
        detach: () => signal.removeEventListener('abort', abort),
      }
      const abort = () => {
        const at = this.pending.indexOf(job)
        if (at >= 0) {
          this.pending.splice(at, 1)
          this.queuedBytes -= job.bytes
          job.detach()
          reject(signal.reason)
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      this.queuedBytes += bytes
      this.pending.push(job)
      void this.drain()
    })
  }
  private async drain() {
    if (this.busy) return
    this.busy = true
    try {
      while (this.pending.length && !this.disposed) {
        const job = this.pending.shift()!
        this.queuedBytes -= job.bytes
        job.detach()
        try {
          job.signal.throwIfAborted()
          const { connection } = this.worker()
          const id = randomUUID()
          const release = () => {
            void connection.call({ type: 'release', id }).catch(() => {})
          }
          const reply = (await connection.call({ type: 'parse', id, text: job.text })) as ParseReply
          if (job.signal.aborted || this.disposed) {
            release()
            throw job.signal.reason ?? new Error('The case parser is closed.')
          }
          if (reply.state === 'invalid') {
            job.resolve(reply)
            continue
          }
          let released = false
          const check = () => {
            if (released) throw new Error('The parsed case is no longer current.')
          }
          try {
            const { data, ...value } = reply.value
            const model = createModel(data, {
              load: async (classId, signal) => {
                check()
                return (await connection.call(
                  { type: 'load', id, classId },
                  { signal },
                )) as ClassData
              },
              bytes: async (signal) => {
                check()
                return (await connection.call({ type: 'bytes', id }, { signal })) as Uint8Array
              },
            })
            job.resolve({
              state: 'valid',
              case: { ...value, model },
              source: async (ref, signal) => {
                check()
                return (
                  ((await connection.call(
                    { type: 'source', id, key: elementKey(ref) },
                    { signal },
                  )) as Span | null) ?? undefined
                )
              },
              dispose: () => {
                if (!released) {
                  released = true
                  release()
                }
              },
            })
          } catch (error) {
            release()
            throw error
          }
        } catch (error) {
          job.reject(error)
        }
      }
    } finally {
      this.busy = false
    }
  }
  dispose() {
    this.disposed = true
    for (const job of this.pending.splice(0)) {
      job.detach()
      job.reject(new Error('The case parser is closed.'))
    }
    this.queuedBytes = 0
    const current = this.current
    this.current = undefined
    current?.connection.close()
    void current?.worker.terminate()
  }
}
