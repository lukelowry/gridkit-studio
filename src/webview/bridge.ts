/** A view's side of the channel to the extension. */

import { problemOf, quiet, superseded } from '../shared/errors.js'
import type { FromView, Of, ToView, ViewApi, ViewMessage, ViewState } from '../shared/messages.js'
import { Caller } from '../shared/rpc.js'
import { applied } from '../shared/state.js'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(value: unknown): void
}

/** A message from the extension, with state changes applied to give the full state. */
export type Received =
  Exclude<ToView, { kind: 'state' | 'reply' }> | { kind: 'state'; of: Of; state: ViewState }

const api = acquireVsCodeApi()
const listeners = new Set<(message: Received) => void>()
/** The envelope of the last state received. Outgoing messages carry it, and incoming ones of
 *  another generation are dropped. */
let of: Of = { uri: undefined, generation: 0 }
let state: ViewState = {}
const extension = new Caller<ViewApi>((message) =>
  api.postMessage({ ...message, of } satisfies FromView),
)

export const bridge = {
  /** The current envelope. A message sent later, such as a seek on the next frame, can pass the
   *  envelope it was made in. */
  get of(): Of {
    return of
  },
  send(message: ViewMessage, from: Of = of) {
    api.postMessage({ ...message, of: from } satisfies FromView)
  },
  ready() {
    api.postMessage({ kind: 'ready' } satisfies FromView)
  },
  on(listener: (message: Received) => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** The page's saved webview state, which survives hiding, or `fallback`. */
  state<T>(fallback: T): T {
    return (api.getState() as T | undefined) ?? fallback
  },
  save(value: unknown) {
    api.setState(value)
  },
  /** Shows `reason` as an extension notification, unless it is quiet, such as a cancellation. */
  report(reason: unknown, context?: unknown) {
    if (quiet(reason)) return
    api.postMessage({ kind: 'error', problem: problemOf(reason), context, of } satisfies FromView)
  },
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
  let received: Received
  if (message.kind === 'visible') {
    document.body.dataset.visible = String(message.visible)
    received = message
  } else if (message.kind === 'state') {
    if (message.of.generation !== of.generation) {
      // A new generation starts from its own state; requests of the previous one fail.
      of = message.of
      state = {}
      extension.fail(superseded())
    }
    state = applied(state, message.changed)
    document.body.dataset.uri = state.uri ?? ''
    received = { kind: 'state', of, state }
  } else if (message.of?.generation !== of.generation) return
  else if (message.kind === 'reply') return extension.settle(message)
  else received = message
  // One listener's failure must not keep the message from the others.
  for (const listener of listeners)
    try {
      listener(received)
    } catch (error) {
      bridge.report(error)
    }
})
window.addEventListener('error', (event) => {
  // Benign: the browser deferred a resize to the next frame.
  if (!event.error && /^ResizeObserver loop/.test(event.message)) return
  bridge.report(event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => bridge.report(event.reason))
