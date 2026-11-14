/** How a view's state crosses to its page: the extension sends each part as it changes, and the
 *  page applies what it is sent. The session replaces a part only as it changes, so a part that is
 *  the same object is the same, and nothing is compared by its contents. */

import type { StateChange, ViewKind, ViewState } from './messages.js'

/** What each kind of view reads of the state: a view is sent a part when it changes, and no part
 *  it does not read. */
const READS = {
  case: ['uri', 'summary', 'stale', 'error', 'selection', 'mappings', 'table'],
  network: [
    'uri',
    'summary',
    'settings',
    'stale',
    'error',
    'networkSelection',
    'mappings',
    'results',
  ],
  monitor: [
    'uri',
    'summary',
    'settings',
    'stale',
    'selection',
    'mappings',
    'plots',
    'window',
    'results',
  ],
  export: [
    'uri',
    'summary',
    'settings',
    'stale',
    'error',
    'mappings',
    'plots',
    'window',
    'results',
  ],
} as const satisfies Record<ViewKind, readonly (keyof ViewState)[]>

/** What a view of `kind` holding `sent` lacks of `state`: each part it reads that is another
 *  object now, or null where it is gone; undefined when it lacks nothing. Results leave out the
 *  outputs the page holds. */
export function changes(
  kind: ViewKind,
  state: ViewState,
  sent: ViewState,
): StateChange | undefined {
  const changed: Record<string, unknown> = {}
  for (const key of READS[kind]) if (state[key] !== sent[key]) changed[key] = state[key] ?? null
  if (!Object.keys(changed).length) return undefined
  const { results } = state
  if (results && 'results' in changed && results.outputs === sent.results?.outputs) {
    const { outputs: _, ...rest } = results
    changed.results = rest
  }
  return changed as StateChange
}

/** `state` with `changed` applied: each part sent takes the place of the one held, and one sent as
 *  null is gone. A part that was not sent stays the object it was, so what a view made of it is not
 *  made again. Results sent without their outputs keep those held. */
export function applied(state: ViewState, changed: StateChange): ViewState {
  const next: Record<string, unknown> = { ...state }
  for (const [key, value] of Object.entries(changed))
    if (value === null) delete next[key]
    else next[key] = value
  const { results } = changed
  if (results)
    next.results = { ...results, outputs: results.outputs ?? state.results?.outputs ?? [] }
  return next
}
