import type { fromJsonSchema } from '@modelcontextprotocol/server'

type Schema = Parameters<typeof fromJsonSchema>[0]
const text: Schema = { type: 'string' }
const number: Schema = { type: 'number' }
const integer: Schema = { type: 'integer', minimum: 0 }
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] })
const array = (items: Schema): Schema => ({ type: 'array', items })
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: 'object', properties, required, additionalProperties: true })
const record: Schema = { type: 'object' }
const revision = object({ uri: text, version: integer })
const domain: Schema = { type: 'array', items: number, minItems: 2, maxItems: 2 }
const observation = nullable(object({ value: number, time: number, frame: integer }))
const stats = object({
  id: text,
  valid: integer,
  missing: integer,
  min: observation,
  max: observation,
})
const snapshot = object({ pages: integer, frames: integer, domain })
const analysis = object({
  run: text,
  revision,
  fingerprint: text,
  state: text,
  snapshot,
  window: domain,
  from: text,
  field: text,
  unit: nullable(text),
  total: integer,
  rows: array(stats),
  evidence: text,
})
const page = (field: string, item: Schema): Schema =>
  object({ [field]: array(item), offset: integer, total: integer, nextOffset: nullable(integer) })
const job = object({ job: text, status: text })
const background = (result: Schema): Schema => ({ anyOf: [result, job] })

/** Stable result envelopes. Extra fields allow metrics and native token-budget annotations. */
export const outputSchemas: Readonly<Record<string, Schema>> = {
  gridkit_inspect_case: { anyOf: [page('cases', record), page('types', record)] },
  gridkit_find_cases: page('cases', object({ uri: text, path: text, open: { type: 'boolean' } })),
  gridkit_open_case: object({ uri: text, version: integer, next: text }),
  gridkit_query_rows: page('rows', object({ id: text, values: record })),
  gridkit_read_diagnostics: page('diagnostics', record),
  gridkit_summarize_run: {
    anyOf: [
      object({
        uri: text,
        current: nullable(record),
        previous: nullable(record),
        retained: array(record),
      }),
      object({ uri: text, run: record }),
    ],
  },
  gridkit_select_elements: object({
    selection: text,
    fingerprint: text,
    from: text,
    count: integer,
    sample: array(text),
  }),
  gridkit_aggregate_case: page('rows', object({ group: {}, count: integer, values: record })),
  gridkit_inspect_neighborhood: page(
    'rows',
    object({ from: text, field: text, to: text, direction: text }),
  ),
  gridkit_analyze_run: background(analysis),
  gridkit_compare_runs: background(
    object({
      before: record,
      after: record,
      matched: integer,
      onlyBefore: integer,
      onlyAfter: integer,
      rows: array(record),
      evidence: text,
    }),
  ),
  gridkit_rank_contingencies: background(
    object({
      study: text,
      revision,
      from: text,
      field: text,
      total: integer,
      rows: array(record),
      evidence: text,
    }),
  ),
  gridkit_query_signals: object({
    run: text,
    revision,
    fingerprint: text,
    snapshot,
    from: text,
    field: text,
    window: domain,
    representation: record,
    series: array(
      object({
        id: text,
        samples: array(object({ time: number, frame: integer, value: nullable(number) })),
      }),
    ),
    nextOffset: nullable(integer),
  }),
  gridkit_read_evidence: object({
    evidence: text,
    summary: record,
    rows: array({}),
    offset: integer,
    total: integer,
    nextOffset: nullable(integer),
  }),
  gridkit_analysis_job: job,
  gridkit_show_element: object({ revision, action: text, element: record }),
  gridkit_propose_edits: object({ action: text, proposal: text, status: text, revision }),
  gridkit_propose_components: object({
    action: text,
    proposal: text,
    status: text,
    revision,
    ids: array(text),
  }),
  gridkit_propose_run: object({
    action: text,
    proposal: text,
    status: text,
    revision,
    preview: record,
    outputs: array(record),
  }),
  gridkit_action_status: object({ action: text, status: text }),
}
