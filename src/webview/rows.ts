/** The case's rows a view draws, as the extension last sent them. */

import { createData, type Data, type Schema } from '@latkit/model'

import type { Rows, ViewState } from '../shared/messages.js'
import { bridge } from './bridge.js'

/** The rows as data, and what they are of. */
export interface Snapshot {
  readonly data: Data
  readonly rows: Rows
}

/** Hears each set of rows the extension sends, which replaces the last. */
export function receiveRows(take: (snapshot: Snapshot) => void): () => void {
  /** Reused while its content is unchanged: each set of rows carries a copy, and the renderers
   *  keep their cached work only for the same schema object. */
  let schema: { readonly value: Schema; readonly text: string } | undefined
  return bridge.on((message) => {
    if (message.kind !== 'rows') return
    const { rows } = message
    const text = JSON.stringify(rows.schema)
    if (schema?.text !== text) schema = { value: rows.schema, text }
    take(Object.freeze({ data: createData(schema.value, rows.batches), rows }))
  })
}

/** Whether `snapshot` holds the rows of the revision `state` shows. */
export function current(snapshot: Snapshot | undefined, state: ViewState): boolean {
  const summary = state.summary
  const revision = snapshot?.rows.revision
  return (
    !!revision &&
    !!summary &&
    revision.uri === summary.uri &&
    revision.version === summary.version &&
    revision.attachmentId === summary.attachmentId
  )
}

/** Whether the Network can draw `snapshot`: rows of this revision, holding the static fields its
 *  mappings read. A sampled field comes from the results, which the view checks against the time
 *  it draws. State may come before its rows, and the last frame stays until both agree. */
export function drawable(snapshot: Snapshot | undefined, state: ViewState): boolean {
  if (!current(snapshot, state) || state.stale) return false
  const summary = state.summary!
  return Object.values(state.bindings ?? {}).every(({ type, field }) => {
    const definition = summary.schema.types[type]?.fields[field]
    if (!definition || definition.sampled) return true
    return snapshot!.rows.fields.some(({ from, select }) => from === type && select.includes(field))
  })
}
