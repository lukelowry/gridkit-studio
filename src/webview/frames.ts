import type { Data } from 'latkit'

import type { FramePage, FrameRequest } from '../shared/data.js'
import { failedWith } from '../shared/errors.js'
import { bridge } from './bridge.js'
import { DatasetSlot } from './datasets.js'
import { loadRenderer } from './runtime.js'

const PAYLOAD_BYTES = 96 * 1024 * 1024

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
  constructor(readonly limit = PAYLOAD_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > PAYLOAD_BYTES)
      throw new Error('Invalid frame cache budget.')
  }

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
          if (epoch === this.#epoch && page.bytes.byteLength <= this.limit) {
            const previous = this.#cache.get(key)
            if (previous) this.#bytes -= previous.bytes.byteLength
            this.#cache.delete(key)
            this.#cache.set(key, page)
            this.#bytes += page.bytes.byteLength
            while (this.#bytes > this.limit) {
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
    const task = (async () => {
      try {
        await loadRenderer()
        const first = await this.reads.page(request, version, controller.signal)
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
            page = await reads.page({ ...request, next: page.next }, version, controller.signal)
            if (page.key !== first.key || page.source !== first.source)
              throw new Error('The result window changed while loading.')
          }
        }
        const published = await this.slot.receive(
          first.source,
          first.key,
          pages(),
          controller.signal,
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

  /** Prefer a compact min/max overview. Gaps and incomplete buckets can require more bytes;
   * retain those details within the page's allocation instead of discarding them. */
  async plot(request: FrameRequest, version: number, signal: AbortSignal): Promise<boolean> {
    const bytes = Math.min(request.bytes, 2 * 1024 * 1024)
    try {
      return await this.receive({ ...request, bytes }, version, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (!failedWith(error, 'limit') || bytes === request.bytes) throw error
      return this.receive(request, version, signal)
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
