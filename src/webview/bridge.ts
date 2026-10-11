/** A view's side of its channel to the extension: what it sends, the requests it makes, and the
 *  messages it hears. */

import { cancelled, defect, detail, message } from '../shared/format.js'
import type { FromView, ToView, ViewApi, ViewState } from '../shared/messages.js'
import { Caller } from '../shared/rpc.js'
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(value: unknown): void
}
const api = acquireVsCodeApi()
const listeners = new Set<(message: ToView) => void>()
const extension = new Caller<ViewApi>((message) => api.postMessage(message))

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
  report(reason: unknown, context?: unknown) {
    if (cancelled(reason)) return
    api.postMessage({
      kind: 'error',
      message: message(reason),
      code: String((reason as { code?: unknown } | null)?.code ?? 'operation-failed'),
      context,
      detail: detail(reason),
      ...(defect(reason) && { defect: true }),
    })
  },
  /** Calls `method` in the extension, as long as it takes unless `signal` lets go of it. */
  request<K extends keyof ViewApi>(
    method: K,
    input: ViewApi[K]['input'],
    signal?: AbortSignal,
  ): Promise<ViewApi[K]['output']> {
    return extension.call(method, input, signal)
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
  if (message.kind === 'reply') return extension.settle(message)
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
