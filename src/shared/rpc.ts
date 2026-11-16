/** The request protocol used between a webview and the extension, and between the extension and
 *  its worker. Each request gets one reply, unless the caller cancels it first. */

import { errorOf, type Problem, problemOf } from './errors.js'

export type Api<A> = { [K in keyof A]: { input: unknown; output: unknown } }

export type Handlers<A extends Api<A>> = {
  readonly [K in keyof A]: (input: A[K]['input'], signal: AbortSignal) => Promise<A[K]['output']>
}

export interface Request {
  kind: 'request'
  id: number
  method: string
  input: unknown
}
export interface Cancel {
  kind: 'cancel'
  id: number
}
export interface Reply {
  kind: 'reply'
  id: number
  value?: unknown
  problem?: Problem
}

/** Calls `A`'s methods over `post` and settles each call when its reply arrives. */
export class Caller<A extends Api<A>> {
  #next = 0
  readonly #pending = new Map<number, { settle(reply: Reply): void; fail(error: Error): void }>()

  constructor(private readonly post: (message: Request | Cancel) => void) {}

  /** Calls `method`; aborting `signal` cancels the request on the other side. */
  call<K extends keyof A & string>(
    method: K,
    input: A[K]['input'],
    signal?: AbortSignal,
  ): Promise<A[K]['output']> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const id = ++this.#next
      const cancel = () => {
        this.#pending.delete(id)
        this.post({ kind: 'cancel', id })
        reject(signal!.reason)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      this.#pending.set(id, {
        settle: ({ value, problem }) => {
          signal?.removeEventListener('abort', cancel)
          if (problem) reject(errorOf(problem))
          else resolve(value as A[K]['output'])
        },
        fail: (error) => {
          signal?.removeEventListener('abort', cancel)
          reject(error)
        },
      })
      try {
        this.post({ kind: 'request', id, method, input })
      } catch (error) {
        // An input that cannot be posted would never get a reply, so fail now.
        this.#pending.get(id)?.fail(error as Error)
        this.#pending.delete(id)
      }
    })
  }

  /** Settles the call `reply` answers, unless it was cancelled. */
  settle(reply: Reply): void {
    const pending = this.#pending.get(reply.id)
    this.#pending.delete(reply.id)
    pending?.settle(reply)
  }

  /** Fails every pending call with `error`, as when the other side is gone. */
  fail(error: Error): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const each of pending) each.fail(error)
  }
}

export interface Answerer {
  receive(message: Request | Cancel): void
  /** Aborts every request in progress, as when the other side is gone. */
  cancel(): void
}

/** Answers requests with `handlers`, posting each reply unless the request was cancelled. `moved`
 *  returns the buffers a reply transfers instead of copying. */
export function answerer<A extends Api<A>>(
  handlers: Handlers<A>,
  post: (reply: Reply, moved: readonly ArrayBufferLike[]) => void,
  moved: (method: string, value: unknown) => readonly ArrayBufferLike[] = () => [],
): Answerer {
  const running = new Map<number, AbortController>()
  const answer = async ({ method, input }: Request, signal: AbortSignal) => {
    const handler = (handlers as Record<string, (input: unknown, signal: AbortSignal) => unknown>)[
      method
    ]
    if (!handler) throw new Error(`Nothing answers ${method}.`)
    return handler(input, signal)
  }
  return {
    receive(message: Request | Cancel): void {
      if (message.kind === 'cancel') return running.get(message.id)?.abort()
      const { id, method } = message
      const controller = new AbortController()
      running.set(id, controller)
      void answer(message, controller.signal)
        .then(
          (value) => {
            if (controller.signal.aborted) return
            try {
              post({ kind: 'reply', id, value }, moved(method, value))
            } catch (error) {
              // A value that cannot be posted is a defect.
              post({ kind: 'reply', id, problem: { ...problemOf(error), defect: true } }, [])
            }
          },
          (error: unknown) => {
            if (!controller.signal.aborted)
              post({ kind: 'reply', id, problem: problemOf(error) }, [])
          },
        )
        .finally(() => running.delete(id))
    },
    cancel(): void {
      for (const controller of running.values()) controller.abort()
      running.clear()
    },
  }
}
