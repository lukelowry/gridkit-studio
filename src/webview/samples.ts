/** The samples a view draws, asked of the worker a chunk at a time. A results file's frames never
 *  change once read, so a view keeps what it was sent, asks only for what it lacks over the times
 *  it shows, and, past its budget, lets go of the chunks farthest from them. */

import {
  appendData,
  blockByteLength,
  type Data,
  type Domain,
  type FieldSelection,
  type SampleBatch,
} from '@latkit/model'

import { recordedWhole } from '../shared/bindings.js'
import { cancelled } from '../shared/format.js'
import type { Results, SamplesInput, VideoView, ViewState } from '../shared/messages.js'

/** The samples a view holds besides those it needs now, in bytes. */
export const SAMPLE_BUDGET = 96 << 20
/** About the most bytes one reply brings. */
const REPLY_BYTES = 8 << 20
/** Results decode to float64. */
const SAMPLE_BYTES = 8

/** One field of results a view draws, and the rows it selects; without rows, every row the file
 *  holds. `rows` counts them. */
export interface Need {
  readonly selection: FieldSelection
  readonly rows: number
}

/** `make`, made once for each state. */
function memo(make: (state: ViewState) => Need[]): (state: ViewState) => Need[] {
  const made = new WeakMap<ViewState, Need[]>()
  return (state) => {
    let needs = made.get(state)
    if (!needs) made.set(state, (needs = make(state)))
    return needs
  }
}

/** The fields the Network maps from its results: each sampled field a mapping reads, of results of
 *  this revision that hold it for every row, as a mapping draws every row. */
export const networkNeeds = memo(({ results, summary, bindings }) => {
  if (!results?.frames || !summary || results.fingerprint !== summary.fingerprint) return []
  const needs = new Map<string, Need>()
  for (const { type, field } of Object.values(bindings ?? {}))
    if (
      summary.schema.types[type]?.fields[field]?.sampled &&
      recordedWhole(results.outputs, summary.counts[type] ?? 0, { type, field })
    )
      needs.set(type + '\n' + field, {
        selection: { from: type, select: [field] },
        rows: summary.counts[type] ?? 0,
      })
  return [...needs.values()]
})

/** The fields the Monitor plots from its results: each they hold, for every row when a plot shows
 *  them all, else for the rows plots name. */
export const plotNeeds = memo(({ results, summary, plots = [] }) => {
  if (!results?.frames || !summary) return []
  const fields = new Map<string, { from: string; field: string; ids?: string[] }>()
  for (const { from, field, id } of plots) {
    if (!results.outputs.some((output) => output.from === from && output.select.includes(field)))
      continue
    const found = fields.get(from + '\n' + field)
    if (!found) fields.set(from + '\n' + field, { from, field, ...(id && { ids: [id] }) })
    else if (!id) delete found.ids
    else if (found.ids && !found.ids.includes(id)) found.ids.push(id)
  }
  return [...fields.values()].map(({ from, field, ids }) => ({
    selection: { from, select: [field], ...(ids && { rows: { kind: 'ids' as const, ids } }) },
    rows: ids?.length ?? summary.counts[from] ?? 0,
  }))
})

/** The fields a video export of `views` draws: the Network's and the Monitor's, a field both read
 *  for every row either reads it for. */
export function exportNeeds(state: ViewState, views: readonly VideoView[]): Need[] {
  const merged = new Map<string, Need>()
  for (const need of [
    ...(views.includes('network') ? networkNeeds(state) : []),
    ...(views.includes('monitor') ? plotNeeds(state) : []),
  ]) {
    const { from, select, rows } = need.selection
    const key = from + '\n' + select[0]
    const found = merged.get(key)
    const ids = (selection: FieldSelection) =>
      selection.rows?.kind === 'ids' ? selection.rows.ids : undefined
    if (!found) merged.set(key, need)
    else if (!rows || !found.selection.rows) merged.set(key, rows ? found : need)
    else {
      const union = [...new Set([...(ids(found.selection) ?? []), ...(ids(need.selection) ?? [])])]
      merged.set(key, {
        selection: { from, select, rows: { kind: 'ids', ids: union } },
        rows: union.length,
      })
    }
  }
  return [...merged.values()]
}

/** What names a selection of fields and rows, so equal selections compare equal. */
export function selectionKey({ from, select, rows }: FieldSelection): string {
  return `${from}\n${select.join(',')}\n${rows ? JSON.stringify(rows) : ''}`
}

/** Where a view looks, and how fast its playhead moves through time. */
export interface Near {
  readonly at: number
  readonly travel: number
}

/** `window` within `domain`, or undefined where they do not meet. */
function clip([a, b]: Domain, [start, end]: Domain): Domain | undefined {
  const from = Math.max(a, start)
  const to = Math.min(b, end)
  return from <= to ? [from, to] : undefined
}

const meet = (a: Domain, b: Domain) => a[0] <= b[1] && b[0] <= a[1]

/** How far `domain` lies from `at`. */
const away = ([start, end]: Domain, at: number) =>
  at < start ? start - at : at > end ? at - end : 0

/** The first frames of one chunk of one need, as held: the times they span, and the pieces that
 *  brought them. */
interface Chunk {
  count: number
  domain: Domain
  readonly pieces: SampleBatch[]
  bytes: number
}

/** An ask of the worker: what one need lacks over a window. */
interface Ask {
  readonly need: Need
  readonly key: string
  readonly window: Domain
  readonly near?: Near
  readonly bytes: number
  /** Whether the view needs it to show what it shows now. */
  readonly required: boolean
  /** What names it once it brought nothing, so it is not asked again until something changes. */
  readonly spent: string
}

export interface SamplesOptions {
  /** Asks the worker, through the extension, for what one need lacks. */
  readonly request: (input: SamplesInput, signal: AbortSignal) => Promise<SampleBatch[]>
  /** Hears each change in what the view holds. */
  readonly changed: () => void
  /** Tells the user why samples could not be read. */
  readonly report: (reason: unknown) => void
  /** The bytes held besides those needed now. */
  readonly budget?: number
}

/** The chunks of one results file a view holds, by need. */
export class Samples {
  #results?: Results
  #needs: readonly Need[] = []
  #named = ''
  /** By need, then chunk. */
  readonly #held = new Map<string, Map<number, Chunk>>()
  /** The times each need's chunks span without a gap, by need. */
  readonly #runs = new Map<string, Domain[]>()
  #bytes = 0
  #required?: Domain
  #near?: Near
  /** Bumped whenever chunks go: data made before then is made again. */
  #generation = 0
  /** The pieces taken in since the generation began, in order. */
  #arrived: { key: string; batch: SampleBatch }[] = []
  #assembled?: {
    rows: Data
    generation: number
    length: number
    ends: Map<string, number>
    value: Data
  }
  /** Asks that brought nothing. */
  readonly #spent = new Set<string>()
  #flight?: { ask: Ask; controller: AbortController }
  #pumping = false
  #again = false
  readonly #budget: number

  constructor(private readonly options: SamplesOptions) {
    this.#budget = options.budget ?? SAMPLE_BUDGET
  }

  /** The results the view holds samples of. */
  get results(): string | undefined {
    return this.#results?.id
  }

  /** Ask for what `needs` of `results` lack over `required`, nearest `near` first; then, with
   *  `near`, for the chunks around it, as far as the budget reaches. */
  want(
    results: Results | undefined,
    needs: readonly Need[],
    required: Domain | undefined,
    near?: Near,
  ): void {
    if (results?.id !== this.#results?.id) this.#reset()
    this.#results = results
    const named = needs.map(({ selection }) => selectionKey(selection)).join('\t')
    if (named !== this.#named) {
      this.#named = named
      this.#needs = needs
      const keys = new Set(needs.map(({ selection }) => selectionKey(selection)))
      for (const key of [...this.#held.keys()]) if (!keys.has(key)) this.#drop(key)
    }
    this.#required = results && required && clip(required, results.domain)
    this.#near = near
    // An ask for times the view no longer shows gives way to what it shows now: one around them,
    // whenever it lacks those; one for times a few chunks away from them, as after a seek. A
    // playhead moving on keeps what it asked for.
    const flight = this.#flight
    if (
      flight &&
      (flight.ask.required
        ? !this.#required || this.#apart(flight.ask.window, this.#required)
        : !this.holds(this.#required))
    )
      flight.controller.abort()
    this.#pump()
  }

  /** `rows` with the samples held. The same value stays while nothing arrives; one that arrives
   *  after what the value has is appended, which keeps what a plot drew. */
  data(rows: Data): Data {
    if (!this.#needs.length || !this.#results) return rows
    const was = this.#assembled
    if (was?.rows === rows && was.generation === this.#generation) {
      if (was.length === this.#arrived.length) return was.value
      const added = this.#arrived.slice(was.length)
      if (added.every(({ key, batch }) => batch.firstFrame >= (was.ends.get(key) ?? 0))) {
        const ends = new Map(was.ends)
        for (const { key, batch } of added)
          ends.set(key, Math.max(ends.get(key) ?? 0, batch.firstFrame + batch.coordinates.length))
        this.#assembled = {
          rows,
          generation: this.#generation,
          length: this.#arrived.length,
          ends,
          value: appendData(
            was.value,
            added.map(({ batch }) => batch),
          ),
        }
        return this.#assembled.value
      }
    }
    // Made anew from every piece held, in frame order.
    const pieces: { key: string; batch: SampleBatch }[] = []
    for (const [key, chunks] of this.#held)
      for (const chunk of chunks.values())
        for (const batch of chunk.pieces) pieces.push({ key, batch })
    pieces.sort((a, b) => a.batch.firstFrame - b.batch.firstFrame)
    const ends = new Map<string, number>()
    for (const { key, batch } of pieces)
      ends.set(key, Math.max(ends.get(key) ?? 0, batch.firstFrame + batch.coordinates.length))
    this.#assembled = {
      rows,
      generation: this.#generation,
      length: this.#arrived.length,
      ends,
      value: appendData(
        rows,
        pieces.map(({ batch }) => batch),
      ),
    }
    return this.#assembled.value
  }

  /** Whether the samples held of `from`'s `field` cover all of `window`. */
  covers(from: string, field: string, window: Domain): boolean {
    const need = this.#needs.find(
      ({ selection }) => selection.from === from && selection.select[0] === field,
    )
    return !!need && this.#covers(selectionKey(need.selection), window)
  }

  /** Whether every need's samples cover `window`, or there is no window to cover. */
  holds(window: Domain | undefined): boolean {
    return (
      !window || this.#needs.every(({ selection }) => this.#covers(selectionKey(selection), window))
    )
  }

  /** Whether what the view needs now cannot be had: each ask for what it lacks brought nothing. */
  get stuck(): boolean {
    const required = this.#required
    const frames = this.#results?.frames
    return (
      !!required &&
      !this.#flight &&
      this.#needs.some(({ selection }) => {
        const key = selectionKey(selection)
        return !this.#covers(key, required) && this.#spent.has(`${key}|${required}|${frames}`)
      })
    )
  }

  /** The needs that hold samples: the fields, and their rows, the view can draw. */
  sampled(): FieldSelection[] {
    return this.#needs
      .map(({ selection }) => selection)
      .filter((selection) => !!this.#held.get(selectionKey(selection))?.size)
  }

  /** What the view holds, for the benchmarks. */
  stats(): { held: number; bytes: number } {
    let held = 0
    for (const chunks of this.#held.values()) held += chunks.size
    return { held, bytes: this.#bytes }
  }

  /** Ask again for what failed, or brought nothing, as when the user reloads a view. */
  retry(): void {
    this.#spent.clear()
    this.#pump()
  }

  /** Let every sample go. */
  clear(): void {
    this.#reset()
    this.#results = undefined
    this.#needs = []
    this.#named = ''
  }

  #reset() {
    this.#flight?.controller.abort()
    this.#held.clear()
    this.#runs.clear()
    this.#bytes = 0
    this.#spent.clear()
    this.#gone()
  }

  /** Chunks went: what was made of them is made again, and asks that brought nothing may now. */
  #gone() {
    this.#generation++
    this.#arrived = []
  }

  #drop(key: string) {
    for (const chunk of this.#held.get(key)?.values() ?? []) this.#bytes -= chunk.bytes
    this.#held.delete(key)
    this.#runs.delete(key)
    this.#gone()
  }

  /** Whether windows `a` and `b` lie more than two chunks' times apart. */
  #apart(a: Domain, b: Domain): boolean {
    const { domain, frames, chunk } = this.#results!
    const span = frames > 1 ? ((domain[1] - domain[0]) * chunk) / (frames - 1) : 0
    return Math.min(away(a, b[0]), away(a, b[1])) > 2 * span
  }

  #covers(key: string, [a, b]: Domain): boolean {
    return this.#spans(key).some(([start, end]) => start <= a && b <= end)
  }

  /** The times `key`'s chunks span, each run of chunks with no frame missing between as one. */
  #spans(key: string): Domain[] {
    const known = this.#runs.get(key)
    if (known) return known
    const runs: [number, number][] = []
    const chunk = this.#results?.chunk ?? 0
    let previous: { k: number; whole: boolean } | undefined
    for (const [k, held] of [...(this.#held.get(key) ?? [])].sort((x, y) => x[0] - y[0])) {
      const last = runs.at(-1)
      if (last && previous?.k === k - 1 && previous.whole) last[1] = held.domain[1]
      else runs.push([held.domain[0], held.domain[1]])
      previous = { k, whole: held.count === chunk }
    }
    this.#runs.set(key, runs)
    return runs
  }

  /** The next ask: what a need lacks to show what the view shows now, then the chunks around it. */
  #next(): Ask | undefined {
    const results = this.#results
    if (!results?.chunk || !results.frames) return undefined
    const required = this.#required
    if (required)
      for (const need of this.#needs) {
        const key = selectionKey(need.selection)
        const spent = `${key}|${required}|${results.frames}`
        if (this.#covers(key, required) || this.#spent.has(spent)) continue
        const near = this.#near ?? { at: required[0], travel: 0 }
        return { need, key, window: required, near, bytes: REPLY_BYTES, required: true, spent }
      }
    const near = this.#near
    if (!near) return undefined
    // The need holding least goes first, a share of a reply at a time, so the fields a view draws
    // together reach as far around it as each other.
    const room = this.#budget - this.#bytes
    const share = Math.min(REPLY_BYTES, room) / this.#needs.length
    const least = this.#needs
      .map((need) => ({ need, key: selectionKey(need.selection) }))
      .map((each) => ({ ...each, held: this.#heldBytes(each.key) }))
      .sort((a, b) => a.held - b.held)
    for (const { need, key } of least) {
      const spent = `${key}|around|${results.frames}|${this.#generation}`
      if (room < this.#chunkBytes(key, need) || this.#spent.has(spent)) continue
      return { need, key, window: results.domain, near, bytes: share, required: false, spent }
    }
    return undefined
  }

  /** The bytes `key`'s chunks hold. */
  #heldBytes(key: string): number {
    let bytes = 0
    for (const chunk of this.#held.get(key)?.values() ?? []) bytes += chunk.bytes
    return bytes
  }

  /** The bytes a chunk of `need` holds: the most one held does, else its times and values. */
  #chunkBytes(key: string, need: Need): number {
    let most = 0
    for (const chunk of this.#held.get(key)?.values() ?? []) most = Math.max(most, chunk.bytes)
    return most || (need.rows + 1) * this.#results!.chunk * SAMPLE_BYTES
  }

  #pump() {
    if (this.#pumping) {
      this.#again = true
      return
    }
    this.#pumping = true
    void this.#serve().finally(() => {
      this.#pumping = false
      if (this.#again) {
        this.#again = false
        this.#pump()
      }
    })
  }

  /** Ask for what the view lacks, one ask at a time, until it lacks nothing it can have. */
  async #serve() {
    for (let ask = this.#next(); ask; ask = this.#next()) {
      const results = this.#results!
      const controller = new AbortController()
      this.#flight = { ask, controller }
      try {
        const batches = await this.options.request(
          {
            results: results.id,
            field: ask.need.selection,
            window: ask.window,
            held: this.#heldOf(ask.key),
            ...(ask.near && { near: ask.near }),
            bytes: ask.bytes,
          },
          controller.signal,
        )
        if (controller.signal.aborted || this.#results?.id !== results.id) continue
        // An ask that brought nothing is not asked again until something changes, which a view
        // waiting on it hears too.
        if (!this.#take(ask.key, batches)) this.#spent.add(ask.spent)
        this.options.changed()
      } catch (error) {
        if (controller.signal.aborted) continue
        this.#spent.add(ask.spent)
        // Results let go of, as when they are cleared or replaced, are no failure.
        if (!cancelled(error) && (error as { code?: string })?.code !== 'results-unavailable')
          this.options.report(error)
        this.options.changed()
      } finally {
        if (this.#flight?.controller === controller) this.#flight = undefined
      }
    }
  }

  /** The frames of each chunk `key` holds. */
  #heldOf(key: string): Record<number, number> {
    const held: Record<number, number> = {}
    for (const [k, chunk] of this.#held.get(key) ?? []) held[k] = chunk.count
    return held
  }

  /** Hold `batches`, the frames `key` lacked; whether any came. */
  #take(key: string, batches: readonly SampleBatch[]): boolean {
    if (!this.#needs.some(({ selection }) => selectionKey(selection) === key)) return false
    const size = this.#results!.chunk
    let chunks = this.#held.get(key)
    if (!chunks) this.#held.set(key, (chunks = new Map()))
    let taken = false
    for (const batch of batches) {
      const count = batch.coordinates.length
      if (!count) continue
      const k = Math.floor(batch.firstFrame / size)
      const end = batch.firstFrame + count - k * size
      const bytes = blockByteLength([batch])
      const found = chunks.get(k)
      if (found) {
        found.pieces.push(batch)
        found.count = Math.max(found.count, end)
        found.domain = [
          Math.min(found.domain[0], batch.coordinates[0]!),
          Math.max(found.domain[1], batch.coordinates[count - 1]!),
        ]
        found.bytes += bytes
      } else
        chunks.set(k, {
          count: end,
          domain: [batch.coordinates[0]!, batch.coordinates[count - 1]!],
          pieces: [batch],
          bytes,
        })
      this.#bytes += bytes
      this.#arrived.push({ key, batch })
      taken = true
    }
    this.#runs.delete(key)
    if (taken && this.#bytes > this.#budget) this.#evict()
    return taken
  }

  /** Past the budget, let go of the chunks farthest from where the view looks, never those it
   *  needs now. */
  #evict() {
    const required = this.#required
    const at = this.#near?.at ?? (required ? (required[0] + required[1]) / 2 : 0)
    const far: { key: string; k: number; chunk: Chunk }[] = []
    for (const [key, chunks] of this.#held)
      for (const [k, chunk] of chunks)
        if (!required || !meet(chunk.domain, required)) far.push({ key, k, chunk })
    far.sort((a, b) => away(b.chunk.domain, at) - away(a.chunk.domain, at))
    let dropped = false
    for (const { key, k, chunk } of far) {
      if (this.#bytes <= this.#budget) break
      this.#held.get(key)!.delete(k)
      this.#runs.delete(key)
      this.#bytes -= chunk.bytes
      dropped = true
    }
    if (dropped) this.#gone()
  }
}
