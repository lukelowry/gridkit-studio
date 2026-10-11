/** A worker thread's side of the extension's requests: each answered by its handler, and the events
 *  the worker sends besides. */

import { parentPort } from 'node:worker_threads'

import { blockBuffers } from '@latkit/model'

import type { FromWorker } from '../shared/messages.js'
import { answerer, type Api, type Handlers } from '../shared/rpc.js'

const port = parentPort!

/** Send the extension `message`, moving `buffers` rather than copying them. */
export function send(message: FromWorker, buffers: readonly ArrayBufferLike[] = []) {
  port.postMessage(
    message,
    buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
  )
}

/** Answer each request with `handlers`. The replies of `moved` methods hold buffers of their own,
 *  which go to the extension without a copy. */
export function serve<A extends Api<A>>(
  handlers: Handlers<A>,
  moved: readonly (keyof A & string)[] = [],
) {
  const moving = new Set<string>(moved)
  const { receive } = answerer(handlers, send, (method, value) =>
    moving.has(method) ? blockBuffers(value) : [],
  )
  port.on('message', receive)
}
