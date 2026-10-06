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
