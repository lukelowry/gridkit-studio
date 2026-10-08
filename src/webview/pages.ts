/** The pages of a run's samples a view holds, and the fields each view needs of them. */

import {
  appendData,
  blockByteLength,
  type Data,
  type FieldSelection,
  type SampleBatch,
} from '@latkit/model'

import { recordedWhole } from '../shared/bindings.js'
import { coversTime } from '../shared/coverage.js'
import type { Begin, VideoView, ViewState } from '../shared/messages.js'
import {
  around,
  type PageEntry,
  pageOf,
  type PageRange,
  selectionKey,
  type Want,
} from '../shared/pages.js'
import { drawable } from '../shared/streams.js'

/** The samples a view holds besides those it needs now, in bytes. */
export const SAMPLE_BUDGET = 96 << 20
/** Results decode to float64. */
const SAMPLE_BYTES = 8

/** One field of a run a view draws, and the rows it selects; without rows, every row the run
 *  recorded. `rows` counts them, which sizes its pages. */
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

/** The fields the Network maps from its run: each sampled field a mapping reads, of a run of this
 *  revision that recorded it for every row, as a mapping draws every row. */
export const networkNeeds = memo(({ run, summary, bindings }) => {
  if (!run?.frames || !summary || run.fingerprint !== summary.fingerprint) return []
  const needs = new Map<string, Need>()
  for (const { type, field } of Object.values(bindings ?? {}))
    if (
      summary.schema.types[type]?.fields[field]?.sampled &&
      recordedWhole(run.outputs, summary.counts[type] ?? 0, { type, field })
    )
      needs.set(type + '\n' + field, {
        selection: { from: type, select: [field] },
        rows: summary.counts[type] ?? 0,
      })
  return [...needs.values()]
})

/** The fields the Monitor plots from its run: each it recorded, for every row when a plot shows
 *  them all, else for the rows plots name. */
export const plotNeeds = memo(({ run, summary, plots = [] }) => {
  if (!run?.frames || !summary) return []
  const fields = new Map<string, { from: string; field: string; ids?: string[] }>()
  for (const { from, field, id } of plots) {
    if (!run.outputs.some((output) => output.from === from && output.select.includes(field)))
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

const drawn = new WeakMap<Begin, WeakMap<ViewState, boolean>>()
/** Whether the Network draws `at` from `data`: its rows are this revision's, and the samples its
 *  mappings read cover that time. */
export function timeReady(
  data: Data | undefined,
  begin: Begin | undefined,
  state: ViewState,
  at: number,
): boolean {
  if (!data || !begin) return false
  let states = drawn.get(begin)
  if (!states) drawn.set(begin, (states = new WeakMap()))
  let rows = states.get(state)
  if (rows === undefined) states.set(state, (rows = drawable(begin, state)))
  if (!rows) return false
  const { run, summary } = state
  if (!run?.frames || run.fingerprint !== summary?.fingerprint) return true
  // No observation exists outside the recording; the view keeps its last valid frame.
  if (at < run.domain[0] || at > run.domain[1]) return false
  return networkNeeds(state).every(({ selection }) =>
    coversTime(data, selection.from, selection.select[0]!, at),
  )
}

/** One need's samples on one page, as the streams brought them. */
interface Held {
  readonly page: number
  readonly batches: readonly SampleBatch[]
  readonly bytes: number
  /** The stream that brought it. */
  readonly stream: number
}

/** What the store last assembled: the rows, and the very pages of each need it holds. */
interface Assembled {
  readonly rows: Data
  readonly needs: string
  readonly held: ReadonlyMap<string, Held>
  /** The frame each need's pages reach. */
  readonly ends: ReadonlyMap<string, number>
  readonly value: Data
  /** The latest stream that brought a page of it. */
  readonly stream: number
}

/** The pages of a run's samples a view holds, a need of a page at a time. It asks for the pages a
 *  view needs now, then those nearest them as far as its budget reaches; past the budget it lets
 *  the farthest go, never those needed now. */
export class PageStore {
  #run = ''
  /** How the run is cut into the pages listed: page numbers mean nothing past it. */
  #paging = ''
  #pages: PageEntry[] = []
  #needs: readonly Need[] = []
  /** The needs, as a key. */
  #named = ''
  /** By need, then page. */
  readonly #held = new Map<string, Map<number, Held>>()
  #bytes = 0
  /** Bumped whenever what is held changes. */
  #version = 0
  #required: PageRange = [0, 0]
  /** Each page asked for, by how near it is: those needed now first. */
  #rank = new Map<number, number>()
  #signature = ''
  #sent?: { required: number; wants: readonly Want[] }
  #assembled?: Assembled

  constructor(
    private readonly send: (want: {
      run: string
      paging: string
      wants: readonly Want[]
      required: number
    }) => void,
    /** The bytes of samples it holds besides those needed now. */
    private readonly budget = SAMPLE_BUDGET,
  ) {}

  /** The run the store holds pages of. */
  get run(): string {
    return this.#run
  }
  /** The pages of that run. */
  get pages(): readonly PageEntry[] {
    return this.#pages
  }

  /** The pages `run`, cut as `paging` names, published from `from` on. Another run's, or the same
   *  run cut anew, start over; a list from the start is the extension starting over, so the store
   *  asks again. */
  list(run: string, paging: string, from: number, pages: readonly PageEntry[]): void {
    if (run !== this.#run || paging !== this.#paging) {
      this.#run = run
      this.#paging = paging
      this.#pages = []
      this.#drop(() => true)
      this.#assembled = undefined
    }
    if (from > this.#pages.length) return
    if (from === 0) this.#sent = undefined
    this.#pages.splice(from, Infinity, ...pages)
    this.#version++
  }

  /** Ask for what `needs` of `run` lack over `required`, then, when `near` is given, over the
   *  pages nearest it, as far as the budget reaches. A view asks again only when what it lacks
   *  changed, and only once it was told of the run's pages. */
  want(
    run: string | undefined,
    needs: readonly Need[],
    required: PageRange,
    near?: { at: number; travel: number },
  ): void {
    if (!run || run !== this.#run) return
    const named = needs.map(({ selection }) => selectionKey(selection)).join('\t')
    if (named !== this.#named) {
      this.#named = named
      this.#needs = needs
      const keys = new Set(named.split('\t'))
      this.#drop((key) => !keys.has(key))
    }
    const signature = [
      run,
      required[0],
      required[1],
      near ? Math.sign(near.travel) : 'span',
      this.#version,
      named,
    ].join(' ')
    if (signature === this.#signature) return
    this.#signature = signature
    this.#required = required
    const rank = new Map<number, number>()
    const wants: Want[] = []
    let bytes = 0
    const ask = (page: number) => {
      rank.set(page, rank.size)
      const fields = needs
        .filter(({ selection }) => !this.#has(selectionKey(selection), page))
        .map(({ selection }) => selection)
      if (fields.length) wants.push({ page, fields })
    }
    for (let page = required[0]; page < Math.min(required[1], this.#pages.length); page++) {
      bytes += this.#size(page)
      ask(page)
    }
    const count = wants.length
    if (near && needs.length)
      for (const page of around(this.#pages, required, near.at, near.travel)) {
        bytes += this.#size(page)
        if (bytes > this.budget) break
        ask(page)
      }
    this.#rank = rank
    if (this.#same(count, wants)) return
    this.#sent = { required: count, wants }
    this.send({ run: this.#run, paging: this.#paging, wants, required: count })
  }

  /** Hold the samples of committed stream `stream` of pages of `run`, cut as `paging` names, each
   *  need of each page once. */
  insert(run: string, paging: string, samples: readonly SampleBatch[], stream: number): void {
    if (run !== this.#run || paging !== this.#paging) return
    const arrived = new Map<string, Map<number, SampleBatch[]>>()
    for (const batch of samples) {
      const page = pageOf(this.#pages, batch.firstFrame)
      if (page < 0) continue
      for (const [field, column] of Object.entries(batch.columns)) {
        const need = this.#needs.find(
          ({ selection }) => selection.from === batch.index.type && selection.select[0] === field,
        )
        if (!need) continue
        const key = selectionKey(need.selection)
        let pages = arrived.get(key)
        if (!pages) arrived.set(key, (pages = new Map()))
        let parts = pages.get(page)
        if (!parts) pages.set(page, (parts = []))
        parts.push({ ...batch, columns: { [field]: column } })
      }
    }
    for (const [key, pages] of arrived) {
      let held = this.#held.get(key)
      if (!held) this.#held.set(key, (held = new Map()))
      for (const [page, batches] of pages) {
        if (held.has(page)) continue
        const bytes = blockByteLength(batches)
        held.set(page, { page, batches, bytes, stream })
        this.#bytes += bytes
      }
    }
    this.#version++
    this.#evict()
  }

  /** Whether every need holds every page of `range`. */
  holds([first, end]: PageRange): boolean {
    if (end > this.#pages.length) return false
    for (let page = first; page < end; page++)
      for (const { selection } of this.#needs)
        if (!this.#has(selectionKey(selection), page)) return false
    return true
  }

  /** `rows` with the pages held. The same value stays while it holds every page needed now that
   *  the store holds: pages sent ahead change nothing drawn. A new value appends when the pages it
   *  adds all follow those it had, which keeps what a plot drew. */
  data(rows: Data, run: string | undefined): Data {
    if (!this.#needs.length || run !== this.#run) return rows
    const was = this.#assembled
    const same = was?.rows === rows && was.needs === this.#named
    if (same && !this.#gained(was)) return was.value
    const held = new Map<string, Held>()
    const ends = new Map<string, number>()
    const all: SampleBatch[] = []
    const added: SampleBatch[] = []
    let stream = 0
    // One append takes its pages in any order, after those the value has, and only while the value
    // still holds the very pages it was made of.
    let appends = same && [...was.held].every(([key, entry]) => this.#entry(key) === entry)
    for (const { selection } of this.#needs) {
      const need = selectionKey(selection)
      const reached = same ? (was.ends.get(need) ?? 0) : 0
      let end = reached
      for (const entry of this.#held.get(need)?.values() ?? []) {
        const key = entry.page + '\n' + need
        held.set(key, entry)
        all.push(...entry.batches)
        stream = Math.max(stream, entry.stream)
        if (same && was.held.get(key) === entry) continue
        const { first, count } = this.#pages[entry.page]!
        if (first < reached) appends = false
        end = Math.max(end, first + count)
        added.push(...entry.batches)
      }
      ends.set(need, end)
    }
    this.#assembled = {
      rows,
      needs: this.#named,
      held,
      ends: appends ? ends : this.#reach(),
      value: appends ? appendData(was!.value, added) : appendData(rows, all),
      stream,
    }
    return this.#assembled.value
  }

  /** The latest stream that brought a page of the last value. */
  get stream(): number {
    return this.#assembled?.stream ?? 0
  }

  /** The needs the last value of `run` holds pages of: the fields, and their rows, it draws. */
  sampled(run: string | undefined): FieldSelection[] {
    const held = this.#assembled?.held
    if (!held || run !== this.#run) return []
    const drawn = new Set([...held.keys()].map((key) => key.slice(key.indexOf('\n') + 1)))
    return this.#needs
      .map(({ selection }) => selection)
      .filter((selection) => drawn.has(selectionKey(selection)))
  }

  /** What the store holds, for the benchmarks. */
  stats(): { listed: number; held: number; bytes: number } {
    let held = 0
    for (const pages of this.#held.values()) held += pages.size
    return { listed: this.#pages.length, held, bytes: this.#bytes }
  }

  /** Let every page go. */
  clear(): void {
    this.#drop(() => true)
    this.#sent = undefined
    this.#signature = ''
  }

  #has(need: string, page: number): boolean {
    return this.#held.get(need)?.has(page) ?? false
  }
  /** The page and need `key` names, as held now. */
  #entry(key: string): Held | undefined {
    const at = key.indexOf('\n')
    return this.#held.get(key.slice(at + 1))?.get(Number(key.slice(0, at)))
  }
  /** The bytes a page holds for every need. */
  #size(page: number): number {
    const { count } = this.#pages[page]!
    return this.#needs.reduce((sum, need) => sum + need.rows * count * SAMPLE_BYTES, 0)
  }
  /** Whether the store holds a page needed now that `was` lacks, or holds it anew. */
  #gained(was: Assembled): boolean {
    for (let page = this.#required[0]; page < this.#required[1]; page++)
      for (const { selection } of this.#needs) {
        const key = page + '\n' + selectionKey(selection)
        const entry = this.#entry(key)
        if (entry && was.held.get(key) !== entry) return true
      }
    return false
  }
  /** The frame each need's held pages reach. */
  #reach(): Map<string, number> {
    const ends = new Map<string, number>()
    for (const [need, pages] of this.#held) {
      let end = 0
      for (const { page } of pages.values()) {
        const { first, count } = this.#pages[page]!
        end = Math.max(end, first + count)
      }
      ends.set(need, end)
    }
    return ends
  }
  /** Whether what the store would ask for is what it asked for last, less what arrived since. */
  #same(required: number, wants: readonly Want[]): boolean {
    const sent = this.#sent
    if (!sent) return false
    let left = 0
    const still: Want[] = []
    sent.wants.forEach(({ page, fields }, i) => {
      const lacking = fields.filter((field) => !this.#has(selectionKey(field), page))
      if (!lacking.length) return
      if (i < sent.required) left++
      still.push({ page, fields: lacking })
    })
    return left === required && JSON.stringify(still) === JSON.stringify(wants)
  }
  /** Past the budget, let go the pages farthest from those needed now, which stay. */
  #evict(): void {
    if (this.#bytes <= this.budget) return
    const [first, end] = this.#required
    const far = (page: number) => this.#rank.get(page) ?? Infinity
    const held = [...this.#held].flatMap(([need, pages]) =>
      [...pages.values()]
        .filter(({ page }) => page < first || page >= end)
        .map((entry) => ({ need, entry })),
    )
    held.sort((a, b) => far(b.entry.page) - far(a.entry.page))
    let dropped = false
    for (const { need, entry } of held) {
      if (this.#bytes <= this.budget) break
      this.#held.get(need)!.delete(entry.page)
      this.#bytes -= entry.bytes
      dropped = true
    }
    // The pages let go may be asked for again.
    if (dropped) this.#sent = undefined
  }
  /** Let go the needs `drop` names. What was assembled from them goes too: the pages that come
   *  in their place, as another run's, are not the same pages. */
  #drop(drop: (need: string) => boolean): void {
    for (const [need, pages] of this.#held)
      if (drop(need)) {
        for (const { bytes } of pages.values()) this.#bytes -= bytes
        this.#held.delete(need)
        this.#assembled = undefined
      }
    this.#version++
    this.#sent = undefined
  }
}
