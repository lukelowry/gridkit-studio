/** A view's side of its channel to the extension: what it sends, the requests it makes, and the
 *  messages it hears. */

import { problemOf, quiet } from '../shared/errors.js'
import type { ViewCommandName } from '../shared/ids.js'
import type { FromView, Results, ToView, ViewApi, ViewState } from '../shared/messages.js'
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
  command(command: ViewCommandName, value?: unknown) {
    api.postMessage({ kind: 'command', command, value } satisfies FromView)
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
   *  extension. A failure that is none says nothing. */
  report(reason: unknown, context?: unknown) {
    if (quiet(reason)) return
    api.postMessage({ kind: 'error', problem: problemOf(reason), context } satisfies FromView)
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
/** The small parts of a state message, which are compared whole. */
const SMALL = ['bindings', 'plots', 'selection', 'anchors', 'table', 'window'] as const

/** Whether two readings of results stand alike: what they hold only grows as they are read. */
const sameResults = (a: Results | undefined, b: Results | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.id === b.id &&
    a.frames === b.frames &&
    a.growing === b.growing &&
    a.error === b.error &&
    a.chunk === b.chunk &&
    a.outputs.length === b.outputs.length)

/** Applies a state message. Each carries the whole state except `summary` and `settings`, which
 *  are large and sent only when they change, as they do with the case a view shows. A part that
 *  did not change stays the object it was, so what a view made of it is not made again. */
export function merged(state: ViewState, incoming: ViewState): ViewState {
  const next: ViewState = {
    ...(incoming.uri === state.uri && { summary: state.summary, settings: state.settings }),
    ...incoming,
  }
  const kept = next as Record<(typeof SMALL)[number], unknown>
  for (const key of SMALL)
    if (JSON.stringify(incoming[key]) === JSON.stringify(state[key])) kept[key] = state[key]
  if (sameResults(state.results, incoming.results)) next.results = state.results
  return next
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
