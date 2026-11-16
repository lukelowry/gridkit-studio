/** The worker side of the extension's RPC: answers requests with handlers, and sends events. */

import { awaitedWork } from '../gridkit/turns.js'
import { port, ready } from '../platform/worker.js'
import type { FromWorker } from '../shared/messages.js'
import { answerer, type Api, type Handlers } from '../shared/rpc.js'
import { transferables } from './transfer.js'

export { memory } from '../platform/host.js'

/** Sends `message` to the extension, transferring `buffers` instead of copying them. */
export function send(message: FromWorker, buffers: readonly ArrayBufferLike[] = []) {
  port.postMessage(
    message,
    buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
  )
}

/** Answers requests with `handlers`. Replies of `moved` methods transfer their buffers, and every
 *  method except `unawaited` ones is foreground work. */
export function serve<A extends Api<A>>(
  handlers: Handlers<A>,
  moved: readonly (keyof A & string)[] = [],
  unawaited: readonly (keyof A & string)[] = [],
) {
  const moving = new Set<string>(moved)
  const background = new Set<string>(unawaited)
  const answers = Object.fromEntries(
    Object.entries<(input: unknown, signal: AbortSignal) => unknown>(handlers).map(
      ([method, handler]) => [
        method,
        background.has(method)
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
  ready()
}
