/** One request protocol for each channel Studio has: a webview and the extension, and the extension
 *  and each of its workers. A request is answered once, with its value or the problem it met,
 *  unless whoever asked lets go of it first, which tells the other side to stop. */

import { errorOf, type Problem, problemOf } from './errors.js'

/** Methods by name: what each takes, and what it answers. */
export type Api<A> = { [K in keyof A]: { input: unknown; output: unknown } }

/** An answer to every method of `A`, each to its own input with its own output. */
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

/** Asks `A`'s methods of whoever `post` reaches, and settles each call as its reply comes. */
export class Caller<A extends Api<A>> {
  #next = 0
  readonly #pending = new Map<number, { settle(reply: Reply): void; fail(error: Error): void }>()

  constructor(private readonly post: (message: Request | Cancel) => void) {}

  /** Calls `method`, as long as it takes unless `signal` lets go of it. */
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
        // An input that cannot cross is never answered: the call fails now.
        this.#pending.get(id)?.fail(error as Error)
        this.#pending.delete(id)
      }
    })
  }

  /** Settles the call `reply` answers, unless it was let go of. */
  settle(reply: Reply): void {
    const pending = this.#pending.get(reply.id)
    this.#pending.delete(reply.id)
    pending?.settle(reply)
  }

  /** Fails every call under way with `error`, as when the other side is gone. */
  fail(error: Error): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const each of pending) each.fail(error)
  }
}

/** The side that answers: it takes each request and cancellation as it comes. */
export interface Answerer {
  receive(message: Request | Cancel): void
  /** Lets go of every request under way, as when the other side is gone. */
  cancel(): void
}

/** Answers requests with `handlers`, posting each reply unless whoever asked let go of it first.
 *  `moved` names the buffers a reply hands over rather than copies. */
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
              // A value that cannot cross is a defect, answered as one.
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
