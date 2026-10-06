import { failure } from '@latkit/model'

import type { FromView, ToView } from '../shared/messages.js'

type Receipt = Extract<FromView, { kind: 'ack' | 'commit' }>
type Delivery = Extract<ToView, { kind: 'batch' | 'end' }>

/** One in-flight batch or final commit. Receipt of bytes never stands for acceptance of data. */
export class StreamDelivery {
  #waiting?: { message: Delivery; finish(error?: unknown): void }

  constructor(private readonly send: (message: ToView) => PromiseLike<boolean>) {}

  receive(receipt: Receipt): void {
    const waiting = this.#waiting
    if (!waiting || receipt.stream !== waiting.message.stream) return
    if (receipt.kind === 'ack') {
      if (waiting.message.kind === 'batch' && receipt.sequence === waiting.message.sequence)
        waiting.finish()
    } else if (waiting.message.kind === 'end') {
      waiting.finish(
        receipt.error && Object.assign(new Error(receipt.error.message), receipt.error),
      )
    }
  }

  post(message: Delivery, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.#waiting) throw new Error('A stream delivery is already pending.')
    return new Promise((resolve, reject) => {
      const abort = () => finish(signal.reason)
      const finish = (error?: unknown) => {
        if (this.#waiting?.finish !== finish) return
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.#waiting = undefined
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(
        () =>
          finish(
            failure(
              'timeout',
              message.kind === 'end' ? 'View commit timed out.' : 'View consumption timed out.',
            ),
          ),
        10_000,
      )
      this.#waiting = { message, finish }
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve()
        .then(() => this.send(message))
        .then((posted) => {
          if (!posted) finish(failure('disconnected', 'View closed.'))
        }, finish)
    })
  }
}
