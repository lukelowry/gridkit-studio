/** Incremental view state sync. The session replaces a part only when it changes, so parts are
 *  compared by identity, never by content. */

import type { StateChange, ViewKind, ViewState } from './messages.js'

/** The state parts each kind of view reads; views are sent only these. */
const READS = {
  case: ['uri', 'summary', 'stale', 'error', 'selection', 'mappings', 'table'],
  network: [
    'uri',
    'summary',
    'settings',
    'exportSettings',
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
    'exportSettings',
    'stale',
    'selection',
    'mappings',
    'monitors',
    'shown',
    'window',
    'results',
  ],
  export: [
    'uri',
    'summary',
    'settings',
    'exportSettings',
    'stale',
    'error',
    'mappings',
    'shown',
    'window',
    'results',
  ],
} as const satisfies Record<ViewKind, readonly (keyof ViewState)[]>

/** The parts of `state` that differ from `sent` for a view of `kind`, with null for removed
 *  parts, or undefined when nothing changed. Results omit outputs the page already has. */
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

/** `state` with `changed` applied; null removes a part. Unsent parts keep their identity, so
 *  nothing derived from them is rebuilt. Results sent without outputs keep the existing ones. */
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
