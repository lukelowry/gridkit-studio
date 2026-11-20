/** Datasets for a page's views, each published only once complete. */

import { Data } from 'latkit'

import type { CaseRowsCursor, CaseRowsPage } from '../../shared/data.js'
import type { ViewApi } from '../../shared/messages.js'
import { bridge } from '../bridge.js'
import { loadLatkit } from './load.js'

interface DatasetVersion {
  readonly key: string
  readonly data: Data
}

/** Publishes complete revisions only; views keep the previous one until their sources change. */
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
  ): Promise<boolean> {
    const generation = ++this.#generation
    this.#pending?.destroy()
    this.#pending = undefined
    signal.throwIfAborted()
    const candidate = new Data(name)
    this.#pending = candidate
    try {
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

/** A case's rows, read from the extension in pages. */
export class CaseRows {
  readonly slot = new DatasetSlot()
  #request = ''
  #controller?: AbortController

  async receive(source: ViewApi['caseRows']['input'], abort?: AbortSignal): Promise<boolean> {
    const key = JSON.stringify(source)
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
      const first = await bridge.request('caseRows', source, signal)
      async function* pages() {
        let page: CaseRowsPage = first
        for (;;) {
          signal.throwIfAborted()
          yield page.bytes
          const cursor: CaseRowsCursor | undefined = page.next
          if (!cursor) return
          page = await bridge.request('caseRows', { ...source, cursor }, signal)
          if (page.key !== first.key) throw new Error('The case changed while its rows loaded.')
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
