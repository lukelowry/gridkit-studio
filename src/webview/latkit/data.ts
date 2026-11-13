/** The datasets a page's views draw, each published whole: a case's rows as the extension projects
 *  them, and whatever else arrives as pages of patches. */

import { Data } from 'latkit'

import type { ProjectionCursor, ProjectionPage, ProjectionSelection } from '../../shared/data.js'
import type { ViewApi } from '../../shared/messages.js'
import { bridge } from '../bridge.js'
import { loadLatkit } from './load.js'

interface DatasetVersion {
  readonly key: string
  readonly data: Data
}

/** Publish complete revisions only. Views keep their previous native source until reassigned. */
export class DatasetSlot {
  #current?: DatasetVersion
  #pending?: Data
  #generation = 0

  get current(): DatasetVersion | undefined {
    return this.#current
  }

  async receive(
    name: string,
    key: string,
    patches: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    base?: string,
  ): Promise<boolean> {
    const generation = ++this.#generation
    this.#pending?.destroy()
    this.#pending = undefined
    signal.throwIfAborted()
    const candidate = new Data(name)
    this.#pending = candidate
    try {
      if (base !== undefined) {
        const current = this.#current
        if (!current || current.key !== base || current.data.name !== name) {
          throw new Error('The dataset update has a different base revision.')
        }
        using snapshot = current.data.snapshot()
        candidate.restore(snapshot)
      }
      for await (const bytes of patches) {
        signal.throwIfAborted()
        if (generation !== this.#generation) return false
        candidate.apply(bytes)
      }
      signal.throwIfAborted()
      if (generation !== this.#generation) return false
      const previous = this.#current
      this.#current = { key, data: candidate }
      this.#pending = undefined
      previous?.data.destroy()
      return true
    } finally {
      if (this.#current?.data !== candidate) candidate.destroy()
      if (this.#pending === candidate) this.#pending = undefined
    }
  }

  clear(): void {
    ++this.#generation
    this.#pending?.destroy()
    this.#current?.data.destroy()
    this.#pending = undefined
    this.#current = undefined
  }
}

/** The rows of a case a page draws, read from the extension a page at a time. */
export class CaseProjection {
  readonly slot = new DatasetSlot()
  #request = ''
  #controller?: AbortController

  async receive(
    source: ViewApi['project']['input'],
    fields: readonly ProjectionSelection[],
    abort?: AbortSignal,
  ): Promise<boolean> {
    const key = JSON.stringify([source, fields])
    if (key === this.#request) return false
    this.#controller?.abort()
    const controller = (this.#controller = new AbortController())
    this.#request = key
    const { signal } = controller
    const cancelled = () => controller.abort(abort?.reason)
    abort?.addEventListener('abort', cancelled, { once: true })
    if (abort?.aborted) cancelled()
    try {
      await loadLatkit()
      signal.throwIfAborted()
      const first = await bridge.request('project', { ...source, fields }, signal)
      async function* pages() {
        let page: ProjectionPage = first
        for (;;) {
          signal.throwIfAborted()
          yield page.bytes
          const cursor: ProjectionCursor | undefined = page.next
          if (!cursor) return
          page = await bridge.request('project', { ...source, fields, cursor }, signal)
          if (page.key !== first.key)
            throw new Error('The projection revision changed while loading.')
        }
      }
      return await this.slot.receive('case', first.key, pages(), signal)
    } catch (error) {
      if (this.#controller === controller) this.#request = ''
      if (signal.aborted && !abort?.aborted) return false
      throw error
    } finally {
      abort?.removeEventListener('abort', cancelled)
    }
  }

  clear(): void {
    this.#controller?.abort()
    this.#request = ''
    this.slot.clear()
  }
}
