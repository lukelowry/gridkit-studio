/** A worker thread's side of the extension's requests: each answered by its handler, and the events
 *  the worker sends besides. */

import { parentPort } from 'node:worker_threads'

import { awaitedWork } from '../gridkit/turns.js'
import type { FromWorker, Memory } from '../shared/messages.js'
import { answerer, type Api, type Handlers } from '../shared/rpc.js'
import { transferables } from './transfer.js'

const port = parentPort!

/** How much memory this worker holds. */
export function memory(): Memory {
  const { heapUsed, arrayBuffers } = process.memoryUsage()
  return { heapUsed, arrayBuffers }
}

/** Send the extension `message`, moving `buffers` rather than copying them. */
export function send(message: FromWorker, buffers: readonly ArrayBufferLike[] = []) {
  port.postMessage(
    message,
    buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
  )
}

/** Answer each request with `handlers`. The replies of `moved` methods hold buffers of their own,
 *  which go to the extension without a copy. Someone waits on each answer but those of `background`
 *  methods, whose long work steps aside while any other request is under way. */
export function serve<A extends Api<A>>(
  handlers: Handlers<A>,
  moved: readonly (keyof A & string)[] = [],
  background: readonly (keyof A & string)[] = [],
) {
  const moving = new Set<string>(moved)
  const behind = new Set<string>(background)
  const answers = Object.fromEntries(
    Object.entries<(input: unknown, signal: AbortSignal) => unknown>(handlers).map(
      ([method, handler]) => [
        method,
        behind.has(method)
          ? handler
          : (input: unknown, signal: AbortSignal) =>
              awaitedWork(async () => handler(input, signal)),
      ],
    ),
  ) as Handlers<A>
  const { receive } = answerer(answers, send, (method, value) =>
    moving.has(method) ? transferables(value) : [],
  )
  port.on('message', receive)
}
