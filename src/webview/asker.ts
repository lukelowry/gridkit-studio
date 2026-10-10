import type { ViewApi } from '../shared/messages.js'

/** What a view asks the extension through: the bridge, or a test's stand-in for it. */
export interface Asker {
  request<K extends keyof ViewApi>(
    method: K,
    input: ViewApi[K]['input'],
    signal?: AbortSignal,
  ): Promise<ViewApi[K]['output']>
  /** Tells the user why something failed. */
  report(reason: unknown, context?: unknown): void
}
