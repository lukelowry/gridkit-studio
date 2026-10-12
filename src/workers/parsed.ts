/** The cases the workers parse, and what they tell the extension of one. */

import { createHash } from 'node:crypto'

import { Case } from '../gridkit/case.js'
import type { Catalog } from '../gridkit/definition.js'
import { editable } from '../gridkit/edits.js'
import { recordingOf } from '../gridkit/recording.js'
import type { Issue, Revision, Summary } from '../shared/messages.js'

/** The name of the case at `uri` when its header gives none: its file's, as the Explorer shows it. */
export const nameOf = (uri: string) => decodeURIComponent(uri.split('/').at(-1) || 'Case')

/** The latest case read for each document, found again while its content is the same, so another
 *  run, open or contingency of it neither sends nor parses the case again, however large. A results
 *  file keeps the case it was read against anyway, so this holds at most each document's newer
 *  version besides. */
export class CaseCache {
  readonly #latest = new Map<string, Case>()

  /** The case read for `uri` whose content `fingerprint` names, when it is the latest. */
  find(uri: string, fingerprint: string): Case | undefined {
    const kase = this.#latest.get(uri)
    return kase?.version === fingerprint ? kase : undefined
  }

  /** `text` of `uri`, parsed, which `find` then finds. */
  async parse(
    uri: string,
    text: string,
    catalog: Catalog,
    name: string,
    signal: AbortSignal,
  ): Promise<Case> {
    signal.throwIfAborted()
    const kase = await Case.parse(text, catalog, name, signal)
    signal.throwIfAborted()
    this.#latest.set(uri, kase)
    return kase
  }

  /** Lets go of the case read for `uri`. */
  forget(uri: string): void {
    this.#latest.delete(uri)
  }
}

/** Cases the case worker read, by the hash of their whole text, so a document opened again parses
 *  nothing. Only whole texts are hashed: an open, or a document let go of, never an edit. Past
 *  `count` cases or about `limit` bytes the least recently used go, and one larger than the limit
 *  is read again when it opens again. */
export class TextCases {
  readonly #entries = new Map<string, { kase: Case; bytes: number }>()
  #bytes = 0
  constructor(
    readonly limit = 128 << 20,
    readonly count = 4,
  ) {}

  /** The key of `text` read as `name` with `catalog`. */
  static key(text: string, catalog: Catalog, name: string): string {
    return createHash('sha256')
      .update(JSON.stringify([catalog.text, name]))
      .update(text)
      .digest('hex')
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
    // The source, its spans and the columns decoded from it, conservatively.
    const bytes =
      kase.file.byteLength * 4 +
      [...kase.tables.values()].reduce(
        (sum, table) => sum + table.records.length * (24 * table.fields.size + 16),
        0,
      )
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

export function summarize(kase: Case, revision: Revision, parseMs = 0, issues?: Issue[]): Summary {
  return {
    ...revision,
    name: kase.name,
    fingerprint: kase.version,
    schema: kase.schema,
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
    recording: recordingOf(kase),
    issues: issues ?? [],
    validation: issues ? 'complete' : 'pending',
    parseMs,
  }
}
