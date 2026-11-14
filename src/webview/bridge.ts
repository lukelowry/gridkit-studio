/** A view's side of its channel to the extension: the state it is sent, what it says back, the
 *  requests it makes, and the messages it hears. */

import { problemOf, quiet, superseded } from '../shared/errors.js'
import type { FromView, Of, ToView, ViewApi, ViewMessage, ViewState } from '../shared/messages.js'
import { Caller } from '../shared/rpc.js'
import { applied } from '../shared/state.js'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(value: unknown): void
}

/** What a page hears: the extension's messages, with the state whole in place of its changes. */
export type Heard =
  Exclude<ToView, { kind: 'state' | 'reply' }> | { kind: 'state'; of: Of; state: ViewState }

const api = acquireVsCodeApi()
const listeners = new Set<(message: Heard) => void>()
/** The showing of the case the view shows, as the last state it was sent says: what the view says
 *  and asks is of it, and what the extension says of another is no longer the view's. */
let of: Of = { uri: undefined, showing: 0 }
/** The state of that showing, as the extension's changes leave it. */
let state: ViewState = {}
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
  /** Tells the extension the page has loaded, and listens. */
  ready() {
    api.postMessage({ kind: 'ready' } satisfies FromView)
  },
  on(listener: (message: Heard) => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** What the page kept for itself, which outlasts its being hidden, or `fallback`. */
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

window.addEventListener('message', (event: MessageEvent<ToView>) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  let heard: Heard
  if (message.kind === 'shown') {
    document.body.dataset.shown = String(message.shown)
    heard = message
  } else if (message.kind === 'state') {
    if (message.of.showing !== of.showing) {
      // A showing begins with its state: what the view held and asked of the one before is past.
      of = message.of
      state = {}
      extension.fail(superseded())
    }
    state = applied(state, message.changed)
    document.body.dataset.uri = state.uri ?? ''
    heard = { kind: 'state', of, state }
  } else if (message.of?.showing !== of.showing) return
  else if (message.kind === 'reply') return extension.settle(message)
  else heard = message
  // One listener's failure leaves the others their message.
  for (const listener of listeners)
    try {
      listener(heard)
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
