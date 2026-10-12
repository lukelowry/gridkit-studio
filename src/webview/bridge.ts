/** A view's side of its channel to the extension: what it sends, the requests it makes, and the
 *  messages it hears. */

import { problemOf, quiet } from '../shared/errors.js'
import type { ViewCommandName } from '../shared/ids.js'
import type {
  FromView,
  Results,
  SentState,
  ToView,
  ViewApi,
  ViewMessage,
  ViewState,
} from '../shared/messages.js'
import { Caller } from '../shared/rpc.js'
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(value: unknown): void
}
const api = acquireVsCodeApi()
const listeners = new Set<(message: ToView) => void>()
const extension = new Caller<ViewApi>((message) => api.postMessage(message))
/** The case the view shows, as the last state it was sent names it: what the view says is of it, and
 *  what the extension says of another is no longer the view's. */
let subject: string | undefined

export const bridge = {
  /** Says `message` of the case the view shows. */
  send(message: ViewMessage) {
    api.postMessage({ ...message, uri: subject } satisfies FromView)
  },
  command(command: ViewCommandName, value?: unknown) {
    bridge.send({ kind: 'command', command, value })
  },
  /** Tells the extension the page has loaded, and listens. */
  ready() {
    api.postMessage({ kind: 'ready' } satisfies FromView)
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
 *  are large and sent only when they change, as they do with the case a view shows, and the
 *  results' outputs, sent only when they change. A part that did not change stays the object it
 *  was, so what a view made of it is not made again. */
export function merged(state: ViewState, incoming: SentState): ViewState {
  const { results, ...rest } = incoming
  const next: ViewState = {
    ...(incoming.uri === state.uri && { summary: state.summary, settings: state.settings }),
    ...rest,
    ...(results && {
      results: { ...results, outputs: results.outputs ?? state.results?.outputs ?? [] },
    }),
  }
  const kept = next as Record<(typeof SMALL)[number], unknown>
  for (const key of SMALL)
    if (JSON.stringify(incoming[key]) === JSON.stringify(state[key])) kept[key] = state[key]
  if (sameResults(state.results, next.results)) next.results = state.results
  return next
}
window.addEventListener('message', (event: MessageEvent<ToView>) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.kind === 'reply') return extension.settle(message)
  if (message.kind === 'state') subject = message.state.uri
  // A clock or an action of a case the view no longer shows is not the view's.
  else if (message.kind !== 'shown' && message.uri !== subject) return
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
