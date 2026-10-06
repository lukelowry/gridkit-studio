import type { Case } from '../gridkit/case.js'
import { diagnose, editable } from '../gridkit/edits.js'
import { parametersOf } from '../gridkit/parameters.js'
import type { Revision, Summary } from '../shared/messages.js'

export function summarize(kase: Case, revision: Revision, parseMs = 0): Summary {
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
    issues: diagnose(kase),
    parseMs,
  }
}

export interface CapturedCase {
  snapshotId: string
  kase: Case
  summary: Summary
}

/** Work owns captured content independently of editor document attachments. */
export class CaseSnapshots {
  readonly #entries = new Map<string, CapturedCase & { references: number }>()
  capture(entry: { kase: Case; summary: Summary }): CapturedCase {
    const snapshotId = entry.summary.uri + '\0' + entry.kase.version
    const found = this.#entries.get(snapshotId)
    if (found) {
      found.references++
      return found
    }
    const captured = { ...entry, snapshotId, references: 1 }
    this.#entries.set(snapshotId, captured)
    return captured
  }
  get(snapshotId: string): CapturedCase {
    const entry = this.#entries.get(snapshotId)
    if (!entry)
      throw Object.assign(new Error('The captured case is no longer available.'), {
        code: 'case-conflict',
      })
    return entry
  }
  retain(snapshotId: string) {
    const entry = this.#entries.get(snapshotId)
    if (!entry) return this.get(snapshotId)
    entry.references++
    return entry
  }
  release(snapshotId: string) {
    const entry = this.#entries.get(snapshotId)
    if (entry && --entry.references === 0) this.#entries.delete(snapshotId)
  }
}
