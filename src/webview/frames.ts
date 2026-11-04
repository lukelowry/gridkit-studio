import type { Data } from 'latkit'

import { type FramePage, type FrameRequest, PAYLOAD_BYTES } from '../shared/data.js'
import { failedWith } from '../shared/errors.js'
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

/** A window of frames for each sampled field a scene maps, which the Network holds around its
 *  playhead, and a video around the frame it draws. Each asks its windows for frames its own way. */
export class SampledWindows {
  readonly #windows = new Map<string, FrameWindow>()

  constructor(readonly reads: FrameReads) {}

  /** The window of `table`'s `field`, made when first asked for. */
  of([table, field]: Sampled): FrameWindow {
    const key = keyOf(table, field)
    let window = this.#windows.get(key)
    if (!window) this.#windows.set(key, (window = new FrameWindow(this.reads)))
    return window
  }

  /** Lets go of every window but those of `fields`; whether any went. */
  keep(fields: readonly Sampled[]): boolean {
    const kept = new Set(fields.map(([table, field]) => keyOf(table, field)))
    let went = false
    for (const [key, window] of this.#windows)
      if (!kept.has(key)) {
        window.clear()
        this.#windows.delete(key)
        went = true
      }
    return went
  }

  /** Where a scene reads `table`'s `field`, once its window holds frames. */
  readonly source = (table: string, field: string): Data | undefined =>
    this.#windows.get(keyOf(table, field))?.data

  /** The frames the windows hold, as a view's sources. */
  get sources(): Data[] {
    return [...this.#windows.values()].flatMap((window) => (window.data ? [window.data] : []))
  }

  /** Whether the window of each of `fields` holds the frames at `at`. */
  hold(fields: readonly Sampled[], at: number): boolean {
    return fields.every(([table, field]) => {
      const range = this.#windows.get(keyOf(table, field))?.range
      return !!range && at >= range[0] && at <= range[1]
    })
  }

  /** What each window holds, and whether it reads more. */
  get spans(): { span?: FrameRequest['range']; pending: boolean }[] {
    return [...this.#windows.values()].map((window) => ({
      span: window.range,
      pending: window.pending,
    }))
  }

  clear(): void {
    for (const window of this.#windows.values()) window.clear()
    this.#windows.clear()
  }
}
