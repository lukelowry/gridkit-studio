/** A worker thread's side of the extension's requests: each answered by `dispatch`, or failed with
 *  why, and cancelled when the extension lets go of it. */

import { parentPort } from 'node:worker_threads'

import { blockBuffers } from '@latkit/model'

import { failureOf } from '../shared/errors.js'
import { defect, detail, message } from '../shared/format.js'
import type { FromWorker, Method, Request, ToWorker } from '../shared/messages.js'

const port = parentPort!

/** Send the extension `message`, moving `buffers` rather than copying them. */
export function send(message: FromWorker, buffers: readonly ArrayBufferLike[] = []) {
  port.postMessage(
    message,
    buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
  )
}

/** Answer each request with `dispatch`. The replies of `moved` methods hold buffers of their own,
 *  which go to the extension without a copy. */
export function serve(
  dispatch: (request: Request, signal: AbortSignal) => Promise<unknown>,
  moved: ReadonlySet<Method>,
) {
  const operations = new Map<number, AbortController>()
  port.on('message', (request: ToWorker) => {
    if (request.kind === 'cancel') return operations.get(request.id)?.abort(new Error('Cancelled'))
    const controller = new AbortController()
    operations.set(request.id, controller)
    const fail = (error: unknown) =>
      send({
        kind: 'error',
        id: request.id,
        problem: failureOf(error, controller.signal.aborted),
        offset: (error as { offset?: number } | null)?.offset,
        length: (error as { length?: number } | null)?.length,
        ...(defect(error) && { defect: true, detail: detail(error) }),
      })
    void dispatch(request, controller.signal)
      .then((value) => {
        try {
          send(
            { kind: 'result', id: request.id, value },
            moved.has(request.method) ? blockBuffers(value) : [],
          )
        } catch (error) {
          // A value that cannot cross to the extension is a defect, answered as one.
          fail(Object.assign(new Error(message(error)), { defect: true, detail: detail(error) }))
        }
      }, fail)
      .finally(() => operations.delete(request.id))
  })
}
