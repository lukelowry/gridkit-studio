import type { Data } from 'latkit'

import { type FramePage, type FrameRequest, PAYLOAD_BYTES, type TimeRange } from '../shared/data.js'
import { failedWith } from '../shared/errors.js'
import type { Results } from '../shared/messages.js'
import { bridge } from './bridge.js'
import { DatasetSlot } from './datasets.js'
import { loadRenderer } from './runtime.js'

/** Shared by every plot and network binding in this page. Cached patch bytes are immutable. */
export class FrameReads {
  readonly #cache = new Map<string, FramePage>()
  readonly #waiters = new Set<() => void>()
  #bytes = 0
  #active = 0
  #epoch = 0
  readonly #pending = new Map<
    string,
    { task: Promise<FramePage>; controller: AbortController; users: number }
  >()

  get bytes(): number {
    return this.#bytes
  }
  get active(): number {
    return this.#active
  }

  async #enter(signal: AbortSignal): Promise<void> {
    while (this.#active >= 2) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          cleanup()
          resolve()
        }
        const abort = () => {
          cleanup()
          reject(signal.reason)
        }
        const cleanup = () => {
          this.#waiters.delete(wake)
          signal.removeEventListener('abort', abort)
        }
        this.#waiters.add(wake)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    signal.throwIfAborted()
    this.#active++
  }

  async page(
    request: FrameRequest & { next?: string },
    version: number,
    signal: AbortSignal,
  ): Promise<FramePage> {
    signal.throwIfAborted()
    const key = JSON.stringify([version, request])
    const found = this.#cache.get(key)
    if (found) {
      this.#cache.delete(key)
      this.#cache.set(key, found)
      return found
    }
    let pending = this.#pending.get(key)
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController()
      const epoch = this.#epoch
      const task = (async () => {
        await this.#enter(controller.signal)
        try {
          const page = await bridge.request('frames', request, controller.signal)
          controller.signal.throwIfAborted()
          if (epoch === this.#epoch && page.bytes.byteLength <= PAYLOAD_BYTES) {
            const previous = this.#cache.get(key)
            if (previous) this.#bytes -= previous.bytes.byteLength
            this.#cache.delete(key)
            this.#cache.set(key, page)
            this.#bytes += page.bytes.byteLength
            while (this.#bytes > PAYLOAD_BYTES) {
              const oldest = this.#cache.entries().next().value!
              this.#cache.delete(oldest[0])
              this.#bytes -= oldest[1].bytes.byteLength
            }
          }
          return page
        } finally {
          this.#active--
          this.#waiters.values().next().value?.()
        }
      })()
      pending = { task, controller, users: 0 }
      this.#pending.set(key, pending)
      const held = pending
      void task
        .finally(() => {
          if (this.#pending.get(key) === held) this.#pending.delete(key)
        })
        .catch(() => {})
    }
    const held = pending
    held.users++
    return new Promise<FramePage>((resolve, reject) => {
      let ended = false
      const finish = (value?: FramePage, error?: unknown) => {
        if (ended) return
        ended = true
        signal.removeEventListener('abort', abort)
        if (--held.users === 0) held.controller.abort()
        if (value) resolve(value)
        else reject(error)
      }
      const abort = () => finish(undefined, signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      held.task.then(
        (value) => finish(value),
        (error) => finish(undefined, error),
      )
      if (signal.aborted) abort()
    })
  }

  clear(): void {
    this.#epoch++
    for (const pending of this.#pending.values()) pending.controller.abort()
    this.#pending.clear()
    this.#cache.clear()
    this.#bytes = 0
  }
}

export class FrameWindow {
  readonly slot = new DatasetSlot()
  #controller?: AbortController
  #key = ''
  #pending?: Promise<boolean>
  #range?: FrameRequest['range']
  #playhead = 0
  #version?: number

  constructor(readonly reads: FrameReads) {}

  get pending(): boolean {
    return this.#pending !== undefined
  }
  /** The read under way, which settles once its window is held. */
  get loading(): Promise<boolean> | undefined {
    return this.#pending
  }
  get data(): Data | undefined {
    return this.slot.current?.data
  }
  get range(): FrameRequest['range'] | undefined {
    return this.#range
  }
  get version(): number | undefined {
    return this.#version
  }
  #requested?: FrameRequest['range']
  get requested(): FrameRequest['range'] | undefined {
    return this.#requested
  }

  receive(request: FrameRequest, version: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const key = JSON.stringify([request, version])
    // A reactive subscriber may dispose its completed request. That abort does not invalidate
    // the immutable dataset already published for this exact window and result revision.
    if (key === this.#key && !this.#pending && this.slot.current) return Promise.resolve(false)
    if (key === this.#key && !this.#controller?.signal.aborted)
      return this.#pending ?? Promise.resolve(false)
    this.#controller?.abort()
    const controller = (this.#controller = new AbortController())
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    this.#key = key
    this.#requested = request.range
    // A plot offers the window it holds, and is sent only what that lacks of a grown one.
    const held = request.purpose === 'plot' ? this.slot.current?.key : undefined
    const asked = held === undefined ? request : { ...request, since: held }
    const task = (async () => {
      try {
        await loadRenderer()
        const first = await this.reads.page(asked, version, controller.signal)
        const reads = this.reads
        async function* pages() {
          let page = first
          const seen = new Set<string>()
          for (;;) {
            controller.signal.throwIfAborted()
            yield page.bytes
            if (page.complete) return
            if (!page.next || seen.has(page.next)) throw new Error('Invalid frame continuation.')
            seen.add(page.next)
            page = await reads.page({ ...asked, next: page.next }, version, controller.signal)
            if (page.key !== first.key || page.source !== first.source)
              throw new Error('The result window changed while loading.')
          }
        }
        const published = await this.slot.receive(
          first.source,
          first.key,
          pages(),
          controller.signal,
          first.base,
        )
        if (published) {
          this.#range = this.data?.describe().span ?? undefined
          this.#version = version
        }
        return published
      } catch (error) {
        if (this.#controller === controller) this.#key = ''
        if (controller.signal.aborted && !signal?.aborted) return false
        throw error
      } finally {
        signal?.removeEventListener('abort', abort)
        if (this.#controller === controller) this.#pending = undefined
      }
    })()
    this.#pending = task
    return task
  }

  async playhead(
    request: FrameRequest,
    version: number,
    at: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const generation = ++this.#playhead
    let range = request.range
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      if (generation !== this.#playhead) return false
      try {
        return await this.receive({ ...request, range }, version, signal)
      } catch (error) {
        if (!failedWith(error, 'limit') || range[0] === range[1]) throw error
        range =
          attempt >= 12
            ? [at, at]
            : [at - Math.max(0, at - range[0]) / 2, at + Math.max(0, range[1] - at) / 2]
      }
    }
  }

  clear(): void {
    this.#playhead++
    this.#controller?.abort()
    this.#key = ''
    this.#pending = undefined
    this.#range = undefined
    this.#version = undefined
    this.slot.clear()
  }
}

/** A sampled field a scene maps: its type, and the field. */
export type Sampled = readonly [table: string, field: string]

const keyOf = (table: string, field: string) => JSON.stringify([table, field])

/** The most frames a second a playing view shows, so the most it asks for. */
export const SHOWN_PER_SECOND = 60
/** How much of the run a playing feed reads at a time, in seconds of playback: one window shows
 *  while the next, which starts where it ends, is read. */
const WINDOW_SECONDS = 2

/** How a view moves through `results`: playing at `rate`, showing `shown` frames a second, or
 *  still. Each field's window may take `bytes`. */
interface Pace {
  readonly results: Pick<Results, 'id' | 'frames' | 'domain'>
  readonly playing: boolean
  readonly rate: number
  readonly shown: number
  readonly bytes: number
}

/** A field's windows: the one that shows, and while playing, the one read after it, which starts
 *  where the first ends. */
interface Lane {
  now: FrameWindow
  next: FrameWindow
}

const holding = (window: FrameWindow, at: number) =>
  !!window.range && at >= window.range[0] && at <= window.range[1]

/** The frames each sampled field a scene maps holds about its playhead: the frame shown while
 *  still, and while playing, the frames the view shows next, each read once and before it is due.
 *  The Network keeps one, and so does a video while it draws. */
export class PlayheadFeed {
  readonly #lanes = new Map<string, Lane>()

  constructor(readonly reads: FrameReads) {}

  /** Keeps each of `fields` about `at` as `pace` moves: the frame at `at` while still; while
   *  playing, a window of the frames shown from `at`, and the window after it, read while the
   *  first shows. Settles once what `at` needs is held, true when a view draws differently for it.
   *  A read ahead that fails is read again once it is due, which says why. */
  async ahead(
    fields: readonly Sampled[],
    at: number,
    pace: Pace,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { results, playing, rate } = pace
    const domain = results.domain ?? [at, at]
    const span = WINDOW_SECONDS * rate
    const read = (window: FrameWindow, [table, field]: Sampled, range: TimeRange) =>
      window.playhead(
        {
          results: results.id,
          table,
          field,
          range,
          purpose: 'playhead',
          bytes: pace.bytes,
          step: playing ? rate / pace.shown : 0,
        },
        results.frames,
        range[0],
        signal,
      )
    let moved = false
    const waits: Promise<boolean>[] = []
    for (const sampled of fields) {
      const lane = this.#lane(sampled)
      if (!playing) lane.next.clear()
      else if (!holding(lane.now, at) && holding(lane.next, at)) {
        // Played past the window that showed, into the one read after it.
        ;[lane.now, lane.next] = [lane.next, lane.now]
        lane.next.clear()
        moved = true
      }
      const asked = lane.now.requested
      if (lane.now.loading && asked && at >= asked[0] && at <= asked[1])
        waits.push(lane.now.loading)
      else if (!holding(lane.now, at) || (!playing && lane.now.version !== results.frames)) {
        // A still view shows the run as it stands, which a growing run changes at its end.
        lane.next.clear()
        const from = Math.min(at, domain[1])
        waits.push(
          read(
            lane.now,
            sampled,
            playing ? [from, Math.max(from, Math.min(domain[1], from + span))] : [at, at],
          ),
        )
      } else if (playing && !lane.next.loading && !lane.next.range) {
        const end = lane.now.range![1]
        if (end < domain[1])
          void read(lane.next, sampled, [end, Math.min(domain[1], end + span)]).catch(() => {})
      }
    }
    return (await Promise.all(waits)).some(Boolean) || moved
  }

  #lane([table, field]: Sampled): Lane {
    const key = keyOf(table, field)
    let lane = this.#lanes.get(key)
    if (!lane)
      this.#lanes.set(
        key,
        (lane = { now: new FrameWindow(this.reads), next: new FrameWindow(this.reads) }),
      )
    return lane
  }

  /** Lets go of every field's windows but those of `fields`; whether any went. */
  keep(fields: readonly Sampled[]): boolean {
    const kept = new Set(fields.map(([table, field]) => keyOf(table, field)))
    let went = false
    for (const [key, lane] of this.#lanes)
      if (!kept.has(key)) {
        lane.now.clear()
        lane.next.clear()
        this.#lanes.delete(key)
        went = true
      }
    return went
  }

  /** Where a scene reads `table`'s `field`: the window that shows, once it holds frames. */
  readonly source = (table: string, field: string): Data | undefined =>
    this.#lanes.get(keyOf(table, field))?.now.data

  /** The frames every window holds, as a view's sources. */
  get sources(): Data[] {
    return [...this.#lanes.values()].flatMap(({ now, next }) =>
      [now.data, next.data].filter((data): data is Data => !!data),
    )
  }

  /** Whether each of `fields` holds the frames at `at`, in the window that shows or the next. */
  holds(fields: readonly Sampled[], at: number): boolean {
    return fields.every(([table, field]) => {
      const lane = this.#lanes.get(keyOf(table, field))
      return !!lane && (holding(lane.now, at) || holding(lane.next, at))
    })
  }

  /** What each window holds, and whether it reads more. */
  get spans(): { span?: FrameRequest['range']; pending: boolean }[] {
    return [...this.#lanes.values()].flatMap(({ now, next }) =>
      [now, next]
        .filter((window) => window.range || window.pending)
        .map((window) => ({ span: window.range, pending: window.pending })),
    )
  }

  clear(): void {
    for (const { now, next } of this.#lanes.values()) {
      now.clear()
      next.clear()
    }
    this.#lanes.clear()
  }
}
