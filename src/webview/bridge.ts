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
  {
    resolve(value: unknown): void
    reject(error: Error): void
    timer?: ReturnType<typeof setTimeout>
    dispose(): void
  }
>()
let next = 0
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
  /** Ask the extension for `method` of `input`. It gives up after `timeout` milliseconds; none
   *  waits as long as the work takes. */
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
      const settle = () => {
        const entry = pending.get(id)
        if (!entry) return false
        entry.dispose()
        clearTimeout(entry.timer)
        pending.delete(id)
        api.postMessage({ kind: 'cancel', id })
        return true
      }
      const cancel = () => {
        if (settle()) reject(new DOMException('Cancelled', 'AbortError'))
      }
      const dispose = () => signal?.removeEventListener('abort', cancel)
      const timer = timeout
        ? setTimeout(() => {
            if (settle()) reject(new Error('The extension did not respond.'))
          }, timeout)
        : undefined
      pending.set(id, {
        resolve: (value) => resolve(value as ViewRequests[K]['output']),
        reject,
        timer,
        dispose,
      })
      signal?.addEventListener('abort', cancel, { once: true })
      api.postMessage({ kind: 'request', id, method, input })
    })
  },
}
/** The view's state after `incoming`. Each message carries all of it but the case's summary and the
 *  settings, which are large and are sent when they change. */
export function merged(state: ViewState, incoming: ViewState): ViewState {
  return { summary: state.summary, settings: state.settings, ...incoming }
}
window.addEventListener('message', (event: MessageEvent<ToView>) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.kind === 'reply') {
    const entry = pending.get(message.id)
    if (entry) {
      clearTimeout(entry.timer)
      entry.dispose()
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error))
      else entry.resolve(message.value)
    }
  } else for (const listener of listeners) listener(message)
})
window.addEventListener('unhandledrejection', (event) =>
  bridge.send({ kind: 'error', message: String(event.reason) }),
)
