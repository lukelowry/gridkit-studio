import type { ProjectionCursor, ProjectionPage, ProjectionSelection } from '../shared/data.js'
import type { ViewApi } from '../shared/messages.js'
import { bridge } from './bridge.js'
import { DatasetSlot } from './datasets.js'
import { loadRenderer } from './runtime.js'

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
      await loadRenderer()
      signal.throwIfAborted()
      const base = this.slot.current?.key
      const first = await bridge.request('project', { ...source, fields, base }, signal)
      async function* pages() {
        let page: ProjectionPage = first
        for (;;) {
          signal.throwIfAborted()
          yield page.bytes
          const cursor: ProjectionCursor | undefined = page.next
          if (!cursor) return
          page = await bridge.request('project', { ...source, fields, cursor, base }, signal)
          if (page.key !== first.key || page.base !== first.base)
            throw new Error('The projection revision changed while loading.')
        }
      }
      return await this.slot.receive('case', first.key, pages(), signal, first.base)
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
