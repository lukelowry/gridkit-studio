import { cancelled, defect, detail, message } from '../shared/format.js'
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
  /** Tell the user why something failed, in the one place Studio does: a notification from the
   *  extension. A cancellation is no failure. */
  report(reason: unknown) {
    if (cancelled(reason)) return
    api.postMessage({
      kind: 'error',
      message: message(reason),
      detail: detail(reason),
      ...(defect(reason) && { defect: true }),
    })
  },
  /** Calls `method` in the extension, as long as it takes unless `signal` cancels it. */
  request<K extends keyof ViewRequests>(
    method: K,
    input: ViewRequests[K]['input'],
    signal?: AbortSignal,
  ): Promise<ViewRequests[K]['output']> {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
    const id = ++next
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!take(id)) return
        api.postMessage({ kind: 'cancel', id })
        reject(new DOMException('Cancelled', 'AbortError'))
      }
      pending.set(id, {
        resolve: (value) => resolve(value as ViewRequests[K]['output']),
        reject,
        release: () => signal?.removeEventListener('abort', cancel),
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
    if (message.cancelled) entry?.reject(new DOMException(message.error, 'AbortError'))
    else if (message.error)
      entry?.reject(
        Object.assign(new Error(message.error), {
          detail: message.detail,
          ...(message.defect && { defect: true }),
        }),
      )
    else entry?.resolve(message.value)
    return
  }
  // One listener's failure leaves the others their message.
  for (const listener of listeners)
    try {
      listener(message)
    } catch (error) {
      bridge.report(error)
    }
})
window.addEventListener('error', (event) => bridge.report(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => bridge.report(event.reason))
