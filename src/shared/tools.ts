import { queryFields } from './tool-fields.js'

export type ToolCapability = 'inspect' | 'display' | 'simulate' | 'edit'
export type JsonSchema = Record<string, unknown>
const text = { type: 'string', minLength: 1 }
const number = { type: 'number' }
const boolean = { type: 'boolean' }
const integer = { type: 'integer', minimum: 0 }
const strings = { type: 'array', items: text, minItems: 1, uniqueItems: true }
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const array = (items: JsonSchema) => ({ type: 'array', items, minItems: 1 })
const page = { offset: integer, limit: { type: 'integer', minimum: 1, default: 20 } }
const caseUri = {
  ...text,
  description: 'Exact workspace case URI from list_cases. The editor need not be open.',
}
const caseRevision = {
  ...text,
  description: 'Content fingerprint from describe_case; independent of editor tab lifetime.',
}
const caseRef = { caseUri, caseRevision }
const target = {
  simulationId: text,
  contingencyIndex: { ...integer, description: 'Zero-based bus-fault contingency index.' },
}
const interval = { type: 'array', items: number, minItems: 2, maxItems: 2 }
const analysis = {
  componentType: text,
  field: text,
  componentIds: strings,
  selectionId: text,
  timeRange: interval,
  metrics: queryFields.metrics,
  order: { enum: ['min', 'max', 'duration'] },
  ...page,
  waitMs: { ...integer, maximum: 30000, default: 0 },
}
const port = object({ componentId: text, field: text }, ['componentId', 'field'])
const changes = array({
  oneOf: [
    object(
      {
        kind: { const: 'add' },
        componentType: text,
        key: { type: ['string', 'number'] },
        fields: { type: 'object' },
      },
      ['kind', 'componentType', 'key', 'fields'],
    ),
    object({ kind: { const: 'set' }, componentId: text, field: text, value: {} }, [
      'kind',
      'componentId',
      'field',
      'value',
    ]),
    object({ kind: { const: 'remove' }, componentIds: strings }, ['kind', 'componentIds']),
    object(
      {
        kind: { const: 'connect' },
        from: port,
        to: {
          anyOf: [object({ componentId: text, field: text }, ['componentId']), { type: 'null' }],
        },
      },
      ['kind', 'from', 'to'],
    ),
    object(
      {
        kind: { const: 'move' },
        componentId: text,
        position: { anyOf: [interval, { type: 'null' }] },
      },
      ['kind', 'componentId', 'position'],
    ),
  ],
})

export interface ToolDefinition {
  name: string
  displayName: string
  modelDescription: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  capability: ToolCapability
}
const errorSchema = object(
  {
    error: {
      type: 'object',
      properties: { code: text, message: text },
      required: ['code', 'message'],
    },
  },
  ['error'],
)
const result = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  anyOf: [{ type: 'object', properties, required }, errorSchema],
})
const paged = {
  items: { type: 'array' },
  total: integer,
  offset: integer,
  nextOffset: { type: ['integer', 'null'] },
}
const receipt = { requestId: text, status: text }
const analysisReceipt = { analysisId: text, status: text, ...paged }
const define = (
  name: string,
  displayName: string,
  capability: ToolCapability,
  modelDescription: string,
  properties: Record<string, JsonSchema>,
  required: string[],
  output: JsonSchema,
): ToolDefinition => ({
  name: 'gridkit_' + name,
  displayName,
  capability,
  modelDescription,
  inputSchema: object(properties, required),
  outputSchema: output,
})

/** The sole tool contract: manifest generation, native chat and MCP consume this catalog. */
export const toolDefinitions: readonly ToolDefinition[] = [
  define(
    'list_cases',
    'List GridKit cases',
    'inspect',
    'Discover workspace case files. Start here; no open-editor prerequisite.',
    page,
    [],
    result(paged, ['items', 'total']),
  ),
  define(
    'describe_case',
    'Describe GridKit case',
    'inspect',
    'Read a compact case inventory, content revision, simulation parameters and current monitored signals. Use describe_component_type for field details.',
    { ...caseRef, ...page, includeEmpty: boolean },
    ['caseUri'],
    result(
      {
        ...caseRef,
        ...paged,
        name: text,
        parameters: { type: 'object' },
        recording: { type: 'array' },
      },
      ['caseUri', 'caseRevision'],
    ),
  ),
  define(
    'describe_component_type',
    'Describe component type',
    'inspect',
    'Read native GridKit fields, units, writable fields, identity, required ports and creation requirements, including types absent from this case.',
    { ...caseRef, componentType: text, fields: strings },
    ['caseUri', 'componentType'],
    result({ ...caseRef, componentType: text, fields: { type: 'object' } }, [
      'componentType',
      'fields',
    ]),
  ),
  define(
    'find_components',
    'Find components',
    'inspect',
    'Query static component fields with filtering, ordering and pagination. Optionally create a reusable selectionId covering every match, not only this page.',
    {
      ...caseRef,
      componentType: text,
      fields: strings,
      componentIds: strings,
      where: queryFields.where,
      orderBy: queryFields.orderBy,
      saveSelection: boolean,
      ...page,
    },
    ['caseUri', 'componentType', 'fields'],
    result({ ...caseRef, ...paged, selectionId: text }, ['items', 'total']),
  ),
  define(
    'summarize_components',
    'Summarize components',
    'inspect',
    'Compute counts and numeric aggregates in the worker; optionally group by a static field. Avoid transferring entire tables.',
    {
      ...caseRef,
      componentType: text,
      fields: strings,
      componentIds: strings,
      where: queryFields.where,
      groupBy: text,
      ...page,
    },
    ['caseUri', 'componentType', 'fields'],
    result({ ...caseRef, ...paged }),
  ),
  define(
    'check_case',
    'Check case',
    'inspect',
    'Return native GridKit diagnostics, component identities and source positions. Invalid source is reported without requiring an open editor.',
    { caseUri, ...page },
    ['caseUri'],
    result({ caseUri, caseRevision, ...paged }, ['items', 'total']),
  ),
  define(
    'trace_connections',
    'Trace connections',
    'inspect',
    'Inspect electrical or control connections from a component, with an explicit hop count and pagination.',
    {
      ...caseRef,
      componentId: text,
      network: { enum: ['electrical', 'control'] },
      hops: integer,
      ...page,
    },
    ['caseUri', 'componentId', 'network', 'hops'],
    result({ ...caseRef, ...paged }),
  ),
  define(
    'edit_case',
    'Apply case changes',
    'edit',
    'Apply one undoable batch of add/set/connect/remove/move changes against caseRevision. Uses native GridKit field paths and Type/key identities. Reuse requestId only for identical retries. Edits remain unsaved in VS Code.',
    { ...caseRef, requestId: text, changes },
    ['caseUri', 'caseRevision', 'requestId', 'changes'],
    result({ ...receipt, changeId: text, caseUri, beforeRevision: text, afterRevision: text }, [
      'requestId',
      'changeId',
      'status',
    ]),
  ),
  define(
    'simulate',
    'Start GridKit simulation',
    'simulate',
    'Capture the case and submit DynamicSimulation or ContingencyAnalysis. Returns simulationId immediately after acceptance. No preview tab or second launch action. Parameters use native GridKit names such as tmax and dt_monitor. fault:false disables only an additional configured fault; authored BusFault components remain. ContingencyAnalysis is a bus-fault study. Retry identical submissions with the same requestId.',
    {
      ...caseRef,
      requestId: text,
      program: { enum: ['DynamicSimulation', 'ContingencyAnalysis'] },
      parameters: { type: 'object' },
      recording: array(
        object({ componentType: text, fields: strings, componentIds: strings, selectionId: text }, [
          'componentType',
          'fields',
        ]),
      ),
    },
    ['caseUri', 'requestId', 'program'],
    result(
      { ...receipt, simulationId: text, caseUri, caseRevision, configuration: { type: 'object' } },
      ['requestId', 'simulationId', 'status'],
    ),
  ),
  define(
    'list_simulations',
    'List simulations',
    'inspect',
    'Discover active and retained simulations, including failed/interrupted simulations and evicted recordings. Does not require open case editors.',
    { caseUri, ...page },
    [],
    result(paged, ['items', 'total']),
  ),
  define(
    'get_simulation',
    'Get simulation',
    'inspect',
    'Read exact simulation status, captured configuration, compact recording coverage, solver evidence and availability. Configuration addedFaults is paged using offset/limit; recording reports scope, counts and sample identities. Use set_result_retention to preserve a comparison baseline.',
    {
      simulationId: text,
      include: array({ enum: ['configuration', 'recording', 'logs'] }),
      ...page,
    },
    ['simulationId'],
    result(
      { ...target, status: text, caseUri, caseRevision, frames: integer, timeRange: interval },
      ['simulationId', 'status'],
    ),
  ),
  define(
    'set_result_retention',
    'Set result retention',
    'display',
    'Keep this simulation recording as a comparison baseline, or release that retention protection. Does not delete files immediately or modify the case.',
    { simulationId: text, retained: boolean },
    ['simulationId', 'retained'],
    result({ simulationId: text, recordingRetained: boolean }, [
      'simulationId',
      'recordingRetained',
    ]),
  ),
  define(
    'stop_simulation',
    'Stop simulation',
    'simulate',
    'Cancel this simulation by ID, including preparation. Leaves completed recordings and unrelated analyses intact.',
    { simulationId: text },
    ['simulationId'],
    result({ simulationId: text, status: text }, ['simulationId', 'status']),
  ),
  define(
    'analyze_results',
    'Analyze results',
    'inspect',
    'Analyze original recorded samples in the worker: extrema, initial/final values, threshold episodes/duration and settling. Returns one analysisId for progress and paged findings. Default waitMs=0. Snapshot coverage is frozen; missing or unrecorded signals are not healthy observations.',
    { ...target, ...analysis },
    ['simulationId', 'componentType', 'field'],
    result(analysisReceipt, ['analysisId', 'status']),
  ),
  define(
    'compare_results',
    'Compare results',
    'inspect',
    'Compare matched component metrics from two captured simulations over their common time interval. Reports unmatched identities and coverage; never interpolates envelope samples for metrics.',
    {
      before: object(target, ['simulationId']),
      after: object(target, ['simulationId']),
      ...analysis,
    },
    ['before', 'after', 'componentType', 'field'],
    result(analysisReceipt, ['analysisId', 'status']),
  ),
  define(
    'read_signal_samples',
    'Read signal samples',
    'inspect',
    'Read exact paged samples or a min/max envelope for plotting. Envelopes are visualization summaries, never inputs to numerical analysis.',
    {
      ...target,
      componentType: text,
      field: text,
      componentIds: strings,
      timeRange: interval,
      representation: queryFields.representation,
    },
    ['simulationId', 'componentType', 'field', 'componentIds', 'timeRange', 'representation'],
    result({ ...target, series: { type: 'array' }, nextOffset: { type: ['integer', 'null'] } }, [
      'simulationId',
      'series',
    ]),
  ),
  define(
    'rank_contingencies',
    'Rank contingencies',
    'inspect',
    'Rank bus-fault contingencies by recorded severity and report failed/unavailable scenarios separately. Uses the study simulationId and optional zero-based contingency indices.',
    { simulationId: text, ...analysis, contingencyIndices: array(integer) },
    ['simulationId', 'componentType', 'field'],
    result(analysisReceipt, ['analysisId', 'status']),
  ),
  define(
    'get_analysis',
    'Get analysis',
    'inspect',
    'Read analysis status or the next immutable page of findings by analysisId. Completed findings survive extension reload. waitMs is a bounded long poll, not a new calculation.',
    { analysisId: text, ...page, waitMs: { ...integer, maximum: 30000 } },
    ['analysisId'],
    result(analysisReceipt, ['analysisId', 'status']),
  ),
  define(
    'stop_analysis',
    'Stop analysis',
    'inspect',
    'Cancel only this analysis. Does not stop its simulation or delete results.',
    { analysisId: text },
    ['analysisId'],
    result(analysisReceipt, ['analysisId', 'status']),
  ),
  define(
    'show_component',
    'Show component',
    'display',
    'Reveal the component source in VS Code and select it in Studio.',
    { ...caseRef, componentId: text, field: text },
    ['caseUri', 'componentId'],
    result({ ...caseRef, componentId: text }, ['caseUri', 'componentId']),
  ),
  define(
    'plot_results',
    'Plot results',
    'display',
    'Show a recorded signal from an explicit simulation in the Monitor, regardless of which simulation is currently displayed.',
    { ...target, componentType: text, field: text, componentId: text, timeRange: interval },
    ['simulationId', 'componentType', 'field'],
    result({ simulationId: text, displayed: boolean }, ['simulationId', 'displayed']),
  ),
]
