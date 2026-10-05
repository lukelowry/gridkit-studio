import type { FromView, ToView, ViewRequests, ViewState } from '../shared/messages.js'
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(value: unknown): void
}
const api = acquireVsCodeApi()
const listeners = new Set<(message: ToView) => void>()
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void; release(): void }
>()
let next = 0
/** Removes request `id` from `pending`, clearing its timeout and abort listener. */
function take(id: number) {
  const entry = pending.get(id)
  pending.delete(id)
  entry?.release()
  return entry
}
export const bridge = {
  send(message: FromView) {
    api.postMessage(message)
  },
  command(command: string, value?: unknown) {
    api.postMessage({ kind: 'command', command, value })
  },
  on(listener: (message: ToView) => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  state<T>(fallback: T): T {
    return (api.getState() as T | undefined) ?? fallback
  },
  save(value: unknown) {
    api.setState(value)
  },
  /** Calls `method` in the extension. Rejects after `timeout` ms; 0 waits as long as it takes. */
  request<K extends keyof ViewRequests>(
    method: K,
    input: ViewRequests[K]['input'],
    signal?: AbortSignal,
    timeout = 15000,
  ): Promise<ViewRequests[K]['output']> {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
    if (pending.size >= 16) return Promise.reject(new Error('Too many pending view requests.'))
    const id = ++next
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        if (!take(id)) return
        api.postMessage({ kind: 'cancel', id })
        reject(error)
      }
      const cancel = () => fail(new DOMException('Cancelled', 'AbortError'))
      const timer = timeout
        ? setTimeout(() => fail(new Error('The extension did not respond.')), timeout)
        : undefined
      pending.set(id, {
        resolve: (value) => resolve(value as ViewRequests[K]['output']),
        reject,
        release: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
        },
      })
      signal?.addEventListener('abort', cancel, { once: true })
      api.postMessage({ kind: 'request', id, method, input })
    })
  },
}
/** Applies a state message. Each carries the whole state except `summary` and `settings`, which
 *  are large and sent only when they change. */
export function merged(state: ViewState, incoming: ViewState): ViewState {
  return { summary: state.summary, settings: state.settings, ...incoming }
}
window.addEventListener('message', (event: MessageEvent<ToView>) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.kind === 'reply') {
    const entry = take(message.id)
    if (message.error) entry?.reject(new Error(message.error))
    else entry?.resolve(message.value)
  } else for (const listener of listeners) listener(message)
})
window.addEventListener('unhandledrejection', (event) =>
  bridge.send({ kind: 'error', message: String(event.reason) }),
)
