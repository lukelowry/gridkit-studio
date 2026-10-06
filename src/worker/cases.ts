import { createHash } from 'node:crypto'

import { Case } from '../gridkit/case.js'
import type { Catalog } from '../gridkit/definition.js'
import { editable } from '../gridkit/edits.js'
import { parametersOf } from '../gridkit/parameters.js'
import type { Issue, Revision, Summary } from '../shared/messages.js'

/** Reopened documents reuse their immutable source index, decoded fields and diagnostics.
 *  The byte budget conservatively includes source, spans and materialized columns; entries
 *  also have a count limit. Active documents own their cases independently of this cache. */
export class CaseCache {
  readonly #entries = new Map<string, { kase: Case; bytes: number }>()
  #bytes = 0
  constructor(
    readonly limit = 128 << 20,
    readonly count = 4,
  ) {}

  async parse(text: string, catalog: Catalog, name: string, signal: AbortSignal): Promise<Case> {
    signal.throwIfAborted()
    const key = createHash('sha256')
      .update(JSON.stringify([catalog.text, name]))
      .update(text)
      .digest('hex')
    const cached = this.#entries.get(key)
    if (cached) {
      this.#entries.delete(key)
      this.#entries.set(key, cached)
      return cached.kase
    }
    const kase = await Case.parse(text, catalog, name, signal)
    signal.throwIfAborted()
    const bytes =
      kase.file.byteLength * 4 +
      [...kase.tables.values()].reduce(
        (sum, table) => sum + table.records.length * (24 * table.fields.size + 16),
        0,
      )
    if (bytes > this.limit || this.count < 1) return kase
    // Another attachment may have finished the same source while this parse yielded.
    const existing = this.#entries.get(key)
    if (existing) return existing.kase
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
    return kase
  }
}

export function summarize(kase: Case, revision: Revision, parseMs = 0, issues?: Issue[]): Summary {
  return {
    ...revision,
    name: kase.name,
    fingerprint: kase.version,
    schema: kase.schema,
    creation: Object.fromEntries(
      [...kase.catalog.shapes]
        .filter(([, shape]) => shape.array)
        .map(([type, shape]) => [
          type,
          {
            keyType: shape.identity.type,
            required: [...shape.plan.values()]
              .filter((plan) => plan.required && plan.source.kind !== 'identity')
              .map((plan) => plan.name),
          },
        ]),
    ),
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
    parameters: parametersOf(kase.catalog),
    issues: issues ?? [],
    validation: issues ? 'complete' : 'pending',
    parseMs,
  }
}
