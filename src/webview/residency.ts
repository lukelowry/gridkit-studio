import type { Domain } from '@latkit/model'

import { recordedWhole } from '../shared/bindings.js'
import { coversTime } from '../shared/coverage.js'
import type { ViewState } from '../shared/messages.js'
import { AHEAD_S, BEHIND_S, drawable, type Held } from '../shared/streams.js'
import type { Snapshot } from './stream.js'

/** Keep recent committed windows within a sample budget, besides a current window larger than it. */
export class CommittedWindows {
  #windows: { snapshot: Snapshot; bytes: number }[] = []
  constructor(private readonly limit = 96 << 20) {}

  add(snapshot: Snapshot): void {
    const previous = this.#windows[0]?.snapshot
    // A view holding the whole run needs no window of it.
    if (!snapshot.begin.held) {
      this.#windows = []
      return
    }
    if (
      previous &&
      (previous.rows !== snapshot.rows ||
        previous.begin.simulationId !== snapshot.begin.simulationId)
    )
      this.#windows = []
    const buffers = new Set<ArrayBufferLike>()
    for (const [type, table] of Object.entries(snapshot.data.tables))
      for (const [field, pages] of Object.entries(table.fields)) {
        if (!snapshot.data.schema.types[type]?.fields[field]?.sampled) continue
        for (const page of pages) {
          if (page.column.kind === 'numeric') buffers.add(page.column.values.buffer)
          if (page.samples) buffers.add(page.samples.coordinates.buffer)
          if (page.rows.kind === 'indices') buffers.add(page.rows.values.buffer)
        }
      }
    const bytes = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0)
    this.#windows.unshift({ snapshot, bytes })
    let total = 0
    this.#windows = this.#windows.filter((entry, i) => {
      total += entry.bytes
      return i === 0 || total <= this.limit
    })
  }

  at(state: ViewState, at: number): Snapshot | undefined {
    const index = this.#windows.findIndex(({ snapshot }) => timeReady(snapshot, state, at))
    if (index < 0) return undefined
    const [entry] = this.#windows.splice(index, 1)
    this.#windows.unshift(entry!)
    return entry!.snapshot
  }
}

const plans = new WeakMap<
  Snapshot,
  WeakMap<ViewState, { drawable: boolean; fields: { type: string; field: string }[] }>
>()

/** A mapping may draw only when all of its required rows cover the requested time. */
export function timeReady(snapshot: Snapshot | undefined, state: ViewState, at: number): boolean {
  if (!snapshot) return false
  let states = plans.get(snapshot)
  if (!states) plans.set(snapshot, (states = new WeakMap()))
  let plan = states.get(state)
  if (!plan) {
    plan = {
      drawable: drawable(snapshot.begin, state),
      fields: Object.values(state.bindings ?? {}).filter(
        ({ type, field }) =>
          state.summary?.schema.types[type]?.fields[field]?.sampled &&
          state.run &&
          recordedWhole(state.run.outputs, state.summary?.counts[type] ?? 0, { type, field }),
      ),
    }
    states.set(state, plan)
  }
  if (!plan.drawable) return false
  const { run, summary } = state
  if (!run?.frames || run.fingerprint !== summary?.fingerprint) return true
  // No observation exists outside the recording; retain the previous valid frame.
  if (at < run.domain[0] || at > run.domain[1]) return false
  return plan.fields.every(({ type, field }) => coversTime(snapshot.data, type, field, at))
}

/** How long before a playhead playing at normal speed reaches the end of what is held it asks for
 *  more, in the run's seconds: a window loads well within it. */
const LEAD_S = 1

/** One requested window per destination; a far seek immediately supersedes the old request. */
export class TimeResidency {
  #requested?: Domain
  constructor(private readonly send: (bounds: Domain) => void) {}

  /** Ask for the times the playhead needs next. `travel` is the clock's rate, signed by the way it
   *  plays, and 0 at rest. A playhead at rest off what is held asks for its moment alone, which
   *  loads soonest. A playing one asks for the times ahead of it before it reaches the end of
   *  what is held: sooner, and farther, the faster it plays. */
  update(at: number, held: Held | undefined, ready: boolean, travel: number): void {
    if (!held) return // The complete recording is already subscribed, including live appends.
    const speed = Math.max(1, Math.abs(travel))
    const lead = LEAD_S * speed
    /** Whether `bounds` holds the playhead with time to spare in the way it plays. */
    const holds = (from: number, to = Infinity) =>
      at >= from && at <= to && (travel === 0 || (travel > 0 ? at <= to - lead : at >= from + lead))
    if (ready && holds(held.from, held.to)) return
    if (this.#requested && holds(...this.#requested)) return
    this.#requested =
      travel === 0
        ? [at, at]
        : travel > 0
          ? [at - BEHIND_S, at + AHEAD_S * speed]
          : [at - AHEAD_S * speed, at + BEHIND_S]
    this.send(this.#requested)
  }

  committed(held: Held | undefined): void {
    if (
      !held ||
      (this.#requested &&
        held.from <= this.#requested[0] &&
        (held.to === undefined || held.to >= this.#requested[1]))
    )
      this.#requested = undefined
  }
}
