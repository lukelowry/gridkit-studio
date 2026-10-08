/** Which streams a view accepts for the case and run it shows. */

import type { Begin, ViewState } from './messages.js'

/** Accept only this revision and run; a stream of rows names no run. */
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

/** State may precede its data. Keep the last frame until this revision's rows carry the static
 *  fields its mappings read. A sampled field comes in pages of the run, which the view checks
 *  against the time it draws. */
export function drawable(begin: Begin | undefined, state: ViewState): boolean {
  if (!begin || !currentStream(begin, state) || state.stale) return false
  const summary = state.summary!
  return Object.values(state.bindings ?? {}).every(({ type, field }) => {
    const definition = summary.schema.types[type]?.fields[field]
    if (!definition || definition.sampled) return true
    return begin.fields.some(({ from, select }) => from === type && select.includes(field))
  })
}
