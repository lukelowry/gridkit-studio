/** Which times of a run a view holds when the whole run is too large. */

import type { Domain } from '@latkit/model'

import { recordedWhole } from './bindings.js'
import type { Begin, ViewState } from './messages.js'

/** Accept only this revision and run; a rows-only stream has no simulation ID. */
export function currentStream(begin: Begin | undefined, state: ViewState): boolean {
  const summary = state.summary
  if (
    !begin ||
    !summary ||
    begin.revision.uri !== summary.uri ||
    begin.revision.version !== summary.version ||
    begin.revision.attachmentId !== summary.attachmentId ||
    (begin.simulationId !== undefined && begin.simulationId !== state.run?.id)
  )
    return false
  return true
}

/** State may precede its data. Keep the last frame until this revision's mapping fields arrive. */
export function drawable(begin: Begin | undefined, state: ViewState): boolean {
  if (!begin || !currentStream(begin, state) || state.stale) return false
  const summary = state.summary!
  return Object.values(state.bindings ?? {}).every(({ type, field }) => {
    const definition = summary.schema.types[type]?.fields[field]
    if (!definition) return true
    if (definition.sampled) {
      const run = state.run
      if (
        !run?.frames ||
        run.fingerprint !== summary.fingerprint ||
        !recordedWhole(run.outputs, summary.counts[type] ?? 0, { type, field })
      )
        return true
      if (begin.simulationId !== run.id) return false
    }
    return begin.fields.some(({ from, select }) => from === type && select.includes(field))
  })
}

/** Without `to`, the window is open-ended. */
export interface Held {
  readonly from: number
  readonly to?: number
}

/** The run samples a view holds whole; past it the view holds the times around what it shows,
 *  and asks for more as it moves. */
export const WHOLE_RUN_BYTES = 48 << 20

/** How far a window reaches ahead of a playhead playing at normal speed, and how far it keeps
 *  behind, in the run's seconds. */
export const AHEAD_S = 4
export const BEHIND_S = 1

/** `held` while it covers `need`, else `need` widened by `margin`. An `open` window has no end, so
 *  frames append to it; it restarts once `need` is three spans past its start, bounding memory. */
export function holdFor(held: Held | undefined, need: Domain, open: boolean, margin: number): Held {
  const span = need[1] - need[0]
  if (held && (held.to === undefined) === open && held.from <= need[0]) {
    if (held.to === undefined ? need[0] - held.from <= 3 * span : held.to >= need[1]) return held
  }
  return { from: need[0] - margin, ...(!open && { to: need[1] + margin }) }
}
