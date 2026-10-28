/** The cases the workers parse, and what they tell the extension of one. */

import { createHash } from 'node:crypto'

import { Case } from '../gridkit/case.js'
import type { Catalog } from '../gridkit/definition.js'
import { editable } from '../gridkit/edits.js'
import { recordingOf } from '../gridkit/recording.js'
import type { Issue, Revision, Summary } from '../shared/messages.js'

/** The name of the case at `uri` when its header gives none: its file's, as the Explorer shows it. */
export const nameOf = (uri: string) => decodeURIComponent(uri.split('/').at(-1) || 'Case')

/** How many bytes of cases, and how many cases, the case worker keeps of documents let go of. */
const KEPT_BYTES = 128 << 20
const KEPT_CASES = 4

/** Cases the case worker read, by the hash of their whole text, so a document opened again parses
 *  nothing. Only whole texts are hashed: an open, or a document let go of, never an edit. Past
 *  `count` cases or about `limit` bytes the least recently used go, and one larger than the limit
 *  is read again when it opens again. */
export class TextCases {
  readonly #entries = new Map<string, { kase: Case; bytes: number }>()
  #bytes = 0
  constructor(
    readonly limit = KEPT_BYTES,
    readonly count = KEPT_CASES,
  ) {}

  /** The key of `text` read as `name` with `catalog`. */
  static key(text: string, catalog: Catalog, name: string): string {
    return createHash('sha256')
      .update(JSON.stringify([catalog.text, name]))
      .update(text)
      .digest('hex')
  }

  /** Whether a case read from `text` may be small enough to keep: one that cannot is never hashed. */
  fits(text: string): boolean {
    return Case.leastBytes(text) <= this.limit
  }

  find(key: string): Case | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.kase
  }

  /** Keeps `kase` by the key `keyOf` gives, asked only for a case small enough to keep. */
  keep(kase: Case, keyOf: () => string): void {
    const { bytes } = kase
    if (bytes > this.limit) return
    const key = keyOf()
    if (this.#entries.has(key)) return
    while (
      this.#entries.size &&
      (this.#bytes + bytes > this.limit || this.#entries.size >= this.count)
    ) {
      const oldest = this.#entries.keys().next().value!
      this.#bytes -= this.#entries.get(oldest)!.bytes
      this.#entries.delete(oldest)
    }
    this.#entries.set(key, { kase, bytes })
    this.#bytes += bytes
  }
}

/** What the extension is told of `kase`, read at `revision`: what it counts, and what it records,
 *  read until `signal` lets go. */
export async function summarize(
  kase: Case,
  revision: Revision,
  {
    parseMs = 0,
    issues,
    signal,
  }: { parseMs?: number; issues?: Issue[]; signal?: AbortSignal } = {},
): Promise<Summary> {
  return {
    ...revision,
    name: kase.name,
    fingerprint: kase.version,
    definition: kase.definition,
    editable: Object.fromEntries(
      [...kase.tables].map(([type, { shape }]) => [
        type,
        [...shape.plan.values()].filter(editable).map((plan) => plan.name),
      ]),
    ),
    identities: Object.fromEntries(
      [...kase.tables].map(([type, { shape }]) => [type, shape.identity.name]),
    ),
    counts: Object.fromEntries(
      [...kase.tables].map(([type, table]) => [type, table.starts.at(-1)!]),
    ),
    recording: await recordingOf(kase, signal),
    issues: issues ?? [],
    validation: issues ? 'complete' : 'pending',
    parseMs,
  }
}
