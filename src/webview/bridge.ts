/** A view's side of its channel to the extension: what it sends, the requests it makes, and the
 *  messages it hears. */

import { problemOf, quiet, superseded } from '../shared/errors.js'
import type { ViewCommandName } from '../shared/ids.js'
import type {
  FromView,
  Of,
  SentState,
  ToView,
  ViewApi,
  ViewMessage,
  ViewState,
} from '../shared/messages.js'
import { Caller } from '../shared/rpc.js'
import { sameDrawn } from '../shared/simulation.js'
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(value: unknown): void
}
const api = acquireVsCodeApi()
const listeners = new Set<(message: ToView) => void>()
/** The showing of the case the view shows, as the last state it was sent says: what the view says
 *  and asks is of it, and what the extension says of another is no longer the view's. */
let of: Of = { uri: undefined, showing: 0 }
const extension = new Caller<ViewApi>((message) =>
  api.postMessage({ ...message, of } satisfies FromView),
)

export const bridge = {
  /** The showing the view shows now. An action made now and said later, as a seek is at the next
   *  frame, is said of it still. */
  get of(): Of {
    return of
  },
  /** Says `message` of the showing `from`: the one the view shows now, unless said otherwise. */
  send(message: ViewMessage, from: Of = of) {
    api.postMessage({ ...message, of: from } satisfies FromView)
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
    const saved = api.getState() as { format?: string; value?: T } | undefined
    return saved?.format === 'view-native-1' ? (saved.value ?? fallback) : fallback
  },
  save(value: unknown) {
    api.setState({ format: 'view-native-1', value })
  },
  /** Tell the user why something failed, in the one place Studio does: a notification from the
   *  extension. A failure that is none says nothing. */
  report(reason: unknown, context?: unknown) {
    if (quiet(reason)) return
    api.postMessage({ kind: 'error', problem: problemOf(reason), context, of } satisfies FromView)
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
  if (sameDrawn(state.results, next.results)) next.results = state.results
  return next
}
window.addEventListener('message', (event: MessageEvent<ToView>) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.kind !== 'shown') {
    if (message.kind === 'state' && message.of.showing !== of.showing) {
      of = message.of
      // What the view asked of the showing before is answered no more.
      extension.fail(superseded())
    } else if (message.of?.showing !== of.showing) return
    if (message.kind === 'reply') return extension.settle(message)
  }
  if (message.kind === 'shown') document.body.dataset.shown = String(message.shown)
  if (message.kind === 'state') document.body.dataset.uri = message.state.uri ?? ''
  // One listener's failure leaves the others their message.
  for (const listener of listeners)
    try {
      listener(message)
    } catch (error) {
      bridge.report(error)
    }
})
window.addEventListener('error', (event) => {
  // A resize the browser put off to the next frame is no failure, and says nothing.
  if (!event.error && /^ResizeObserver loop/.test(event.message)) return
  bridge.report(event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => bridge.report(event.reason))
