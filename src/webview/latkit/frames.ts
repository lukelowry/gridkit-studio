/** Frames of mapped sampled fields, read from the results worker around the playhead. */

import type { Data } from 'latkit'

import type { FrameRequest, TimeRange } from '../../shared/data.js'
import { fieldKey } from '../../shared/document.js'
import type { Results } from '../../shared/messages.js'
import { bridge } from '../bridge.js'
import { DatasetSlot } from './data.js'
import { loadLatkit } from './load.js'

/** A field's frames from the one at or before the requested start, up to one page of them. */
export class FrameWindow {
  readonly slot = new DatasetSlot()
  #controller?: AbortController
  #key = ''
  #pending?: Promise<boolean>
  #range?: TimeRange
  #requested?: FrameRequest
  #published?: FrameRequest
  #version?: number

  get loading(): Promise<boolean> | undefined {
    return this.#pending
  }
  get data(): Data | undefined {
    return this.slot.current?.data
  }
  /** The time span of the loaded frames. */
  get range(): TimeRange | undefined {
    return this.#range
  }
  get requested(): FrameRequest | undefined {
    return this.#requested
  }
  covers(at: number, exact: boolean): boolean {
    const range = this.#range
    const request = this.#published
    if (!range || !request || at < range[0] || at > range[1]) return false
    if (!exact) return true
    // A lookahead frame may be the first of two values at a fault timestamp.
    // An exact seek there must read the last one. Playback windows also skip samples.
    return request.step === 0 && (at < range[1] || at === request.range[0])
  }
  /** The results' frame count when the loaded frames were read. */
  get version(): number | undefined {
    return this.#version
  }

  /** Reads `request` at frame count `version` unless it is loaded or loading already; resolves true
   *  once it publishes a new window. Aborting through `signal` alone keeps the current window. */
  receive(request: FrameRequest, version: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const key = JSON.stringify([request, version])
    if (key === this.#key && (this.#pending || this.slot.current))
      return this.#pending ?? Promise.resolve(false)
    this.#controller?.abort()
    const controller = (this.#controller = new AbortController())
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    this.#key = key
    this.#requested = request
    const task = (async () => {
      try {
        await loadLatkit()
        const page = await bridge.request('frames', request, controller.signal)
        const published = await this.slot.receive(
          page.source,
          key,
          (async function* () {
            yield page.bytes
          })(),
          controller.signal,
        )
        if (published) {
          this.#published = request
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

  clear(): void {
    this.#controller?.abort()
    this.#key = ''
    this.#pending = undefined
    this.#range = undefined
    this.#requested = undefined
    this.#published = undefined
    this.#version = undefined
    this.slot.clear()
  }
}

export type Sampled = readonly [table: string, field: string]

/** The highest frame rate a playing view shows, which caps the frames it requests. */
export const MAX_FRAME_RATE = 60
/** Seconds of playback per window while playing; a window also ends where its page ends. */
const WINDOW_SECONDS = 2

interface Pace {
  readonly results: Pick<Results, 'id' | 'frames' | 'domain'>
  readonly playing: boolean
  readonly rate: number
  readonly frameRate: number
}

/** A field's shown window and the one read after it. A failed read is retried only once the
 *  results, play state or paused time differ from `failed`. */
interface Lane {
  now: FrameWindow
  next: FrameWindow
  failed?: string
}

interface Listener {
  changed(): void
  failed(error: unknown): void
}

/** Frames of each mapped sampled field around the playhead, read ahead while playing. */
export class PlayheadFeed {
  readonly #lanes = new Map<string, Lane>()

  constructor(readonly listener: Listener = { changed() {}, failed() {} }) {}

  /** Loads `fields` at `at`: one frame while paused, or a window and the next one while playing.
   *  Resolves once `at` is covered, and rejects if a read it waits on fails. */
  async ahead(
    fields: readonly Sampled[],
    at: number,
    pace: Pace,
    signal?: AbortSignal,
  ): Promise<void> {
    const { results, playing, rate } = pace
    const domain = results.domain ?? [at, at]
    const span = WINDOW_SECONDS * rate
    const moment = JSON.stringify([results.id, results.frames, playing || at])
    const read = (
      lane: Lane,
      window: FrameWindow,
      [table, field]: Sampled,
      range: TimeRange,
    ): Promise<boolean> => {
      const task = window.receive(
        { results: results.id, table, field, range, step: playing ? rate / pace.frameRate : 0 },
        results.frames,
        signal,
      )
      task.then(
        (published) => {
          if (published && window === lane.now) this.listener.changed()
        },
        (error: unknown) => {
          if (signal?.aborted) return
          lane.failed = moment
          this.listener.failed(error)
        },
      )
      return task
    }
    const waits: Promise<boolean>[] = []
    for (const sampled of fields) {
      const lane = this.#lane(sampled)
      if (!playing) lane.next.clear()
      else if (!lane.now.covers(at, false) && lane.next.covers(at, false)) {
        // Played into the window read ahead.
        ;[lane.now, lane.next] = [lane.next, lane.now]
        lane.next.clear()
        this.listener.changed()
      }
      if (lane.failed === moment) continue
      lane.failed = undefined
      const requested = lane.now.requested
      if (
        lane.now.loading &&
        requested &&
        (playing || requested.step === 0) &&
        at >= requested.range[0] &&
        at <= requested.range[1]
      )
        waits.push(lane.now.loading)
      else if (
        !lane.now.covers(at, !playing) ||
        // Paused past the last frame of a growing run: read again to show the frames since.
        (!playing && lane.now.version !== results.frames && at >= lane.now.range![1])
      ) {
        lane.next.clear()
        const from = Math.min(at, domain[1])
        waits.push(
          read(
            lane,
            lane.now,
            sampled,
            playing ? [from, Math.max(from, Math.min(domain[1], from + span))] : [at, at],
          ),
        )
      } else if (playing && !lane.next.loading && !lane.next.range) {
        const end = lane.now.range![1]
        if (end < domain[1])
          void read(lane, lane.next, sampled, [end, Math.min(domain[1], end + span)]).catch(
            () => {},
          )
      }
    }
    await Promise.all(waits)
  }

  #lane([table, field]: Sampled): Lane {
    const key = fieldKey({ table, field })
    let lane = this.#lanes.get(key)
    if (!lane) this.#lanes.set(key, (lane = { now: new FrameWindow(), next: new FrameWindow() }))
    return lane
  }

  /** Drops the windows of every field not in `fields`. */
  keep(fields: readonly Sampled[]): void {
    const kept = new Set(fields.map(([table, field]) => fieldKey({ table, field })))
    let dropped = false
    for (const [key, lane] of this.#lanes)
      if (!kept.has(key)) {
        dropped ||= !!lane.now.data
        lane.now.clear()
        lane.next.clear()
        this.#lanes.delete(key)
      }
    if (dropped) this.listener.changed()
  }

  readonly source = (table: string, field: string): Data | undefined =>
    this.#lanes.get(fieldKey({ table, field }))?.now.data

  /** The shown windows' datasets. A window read ahead becomes a source only once shown, since it
   *  has the same name as the shown one. */
  get sources(): Data[] {
    return [...this.#lanes.values()].flatMap(({ now }) => (now.data ? [now.data] : []))
  }

  covers(fields: readonly Sampled[], at: number, exact = false): boolean {
    return fields.every(([table, field]) =>
      this.#lanes.get(fieldKey({ table, field }))?.now.covers(at, exact),
    )
  }

  get spans(): { span?: TimeRange; pending: boolean }[] {
    return [...this.#lanes.values()].flatMap(({ now, next }) =>
      [now, next]
        .filter((window) => window.range || window.loading)
        .map((window) => ({ span: window.range, pending: !!window.loading })),
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
