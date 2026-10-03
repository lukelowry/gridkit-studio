import type {
  DataBatch,
  Domain,
  FieldSelection,
  FieldValues,
  Parameters,
  Query,
  QueryBlock,
  Schema,
  Value,
} from '@latkit/model'

import type { Bindings } from './bindings.js'
import type { SettingsValues } from './preferences.js'
export interface SourceRange {
  offset: number
  length: number
}
export interface SourceEdit extends SourceRange {
  text: string
}
export interface Issue extends SourceRange {
  message: string
  severity: 'info' | 'warning' | 'error'
  id?: string
  field?: string
}

export interface Revision {
  uri: string
  version: number
}
export interface Element {
  id: string
  field?: string
}
export interface Summary extends Revision {
  editable: Record<string, string[]>
  name: string
  fingerprint: string
  schema: Schema
  counts: Record<string, number>
  parameters: Parameters
  issues: Issue[]
  parseMs: number
}
export interface RuntimeProcess {
  pid: number
  executable: string
  container?: string
}
export interface RuntimeOptions {
  method: 'auto' | 'installed' | 'docker' | 'podman'
  executable: string
  image: string
}
export interface RunInfo {
  id: string
  revision: Revision
  fingerprint: string
  name: string
  state: 'running' | 'complete' | 'cancelled' | 'failed'
  path: string
  format: 'arrow' | 'csv'
  frames: number
  domain: Domain
  message?: string
  started: number
  outputs: readonly FieldSelection[]
}
export interface RunRequest extends Revision {
  values: Record<string, unknown>
  outputs: readonly FieldSelection[]
  runtime: RuntimeOptions
  cacheBytes: number
}
export interface SourceContext {
  element?: Element
  range?: SourceRange
  type?: string
  completions: { name: string; detail: string; description?: string }[]
  reference?: string
}
export type Mutation =
  | { kind: 'remove'; ids: readonly string[] }
  | { kind: 'set'; id: string; field: string; value: Value }
  | { kind: 'move'; id: string; position: readonly [number, number] | null }
  | { kind: 'connect'; from: Element & { field: string }; to: Element | null }
export interface Requests {
  transact: { input: Revision & { mutations: readonly Mutation[] }; output: SourceEdit[] }
  placement: { input: Revision; output: Record<string, FieldValues> }
  presentation: { input: Revision; output: Record<string, FieldValues> }

  complete: { input: { text: string; offset: number }; output: SourceContext['completions'] }
  context: { input: Revision & { offset: number }; output: SourceContext }
  symbols: { input: Revision; output: (SourceRange & { name: string; detail: string })[] }
  step: { input: { run: string; at: number; direction: -1 | 1 }; output: number }
  parse: {
    input: Revision &
      ({ text: string } | { baseVersion: number; changes: readonly (readonly SourceEdit[])[] })
    output: Summary
  }
  query: { input: Revision & { query: Query; run?: string }; output: QueryBlock[] }
  batches: {
    input: Revision & {
      fields?: readonly FieldSelection[]
      run?: string
      window?: Domain
      includeStatic?: boolean
    }
    output: null
  }
  locate: { input: Revision & Element; output: SourceRange }
  edit: { input: Revision & Element & { field: string; value: Value }; output: SourceEdit[] }
  run: { input: RunRequest; output: RunInfo }
  stop: { input: { uri: string }; output: null }
  runs: { input: { uri: string }; output: RunInfo[] }
  clear: { input: { uri: string }; output: null }
  release: { input: { uri: string }; output: null }
  import: { input: Revision & { path: string; cacheBytes: number }; output: RunInfo }
  export: { input: { run: string; path: string }; output: null }
  stats: {
    input: Record<string, never>
    output: {
      cacheBytes: number
      sessions: number
      runs: number
      memory: { heapUsed: number; arrayBuffers: number }
    }
  }
}
export type Method = keyof Requests
export type Request = {
  [K in Method]: { kind: 'request'; id: number; method: K; input: Requests[K]['input'] }
}[Method]
export type ToWorker = Request | { kind: 'cancel' | 'ack'; id: number }
export type FromWorker =
  | { kind: 'process'; uri: string; process?: RuntimeProcess }
  | { kind: 'result'; id: number; value: unknown }
  | { kind: 'error'; id: number; message: string; offset?: number; length?: number }
  | { kind: 'batch'; id: number; batches: readonly DataBatch[] }
  | { kind: 'run'; info: RunInfo }
  | { kind: 'log'; uri: string; message: string }
export type EditorKind = 'network' | 'diagram' | 'table'
export interface Plot {
  from: string
  field: string
  id?: string
}
export interface ViewState {
  uri?: string
  version?: number
  writable?: boolean
  settings?: SettingsValues
  loop?: 'none' | 'wrap' | 'pingpong'
  speed?: number
  values?: Record<string, unknown>
  table?: { type?: string; fields?: string[]; filter?: string }

  diagramEditing?: boolean
  playing?: boolean
  navigate?: boolean
  follow?: boolean
  bindings?: Bindings
  summary?: Summary
  stale?: boolean
  selection?: Element
  run?: RunInfo
  at?: number
  plots?: Plot[]
}
export type ToView =
  | { kind: 'state'; state: ViewState }
  | {
      kind: 'begin'
      stream: number
      schema: Schema
      revision: Revision
      base: boolean
      window?: Domain
      positions?: Record<string, FieldValues>
    }
  | { kind: 'batch'; stream: number; sequence: number; batches: readonly DataBatch[] }
  | { kind: 'end'; stream: number }
  | { kind: 'reply'; id: number; value?: unknown; error?: string }
  | { kind: 'action'; command: string; value?: unknown }
export type FromView =
  | { kind: 'cancel'; id: number }
  | { kind: 'overlap'; elements: Element[] }
  | { kind: 'window'; bounds: Domain }
  | { kind: 'values'; uri: string; values: Record<string, unknown> }
  | { kind: 'tableState'; table: { type?: string; fields?: string[]; filter?: string } }
  | { kind: 'ready' }
  | { kind: 'ack'; stream: number; sequence: number }
  | { kind: 'select'; element: Element }
  | { kind: 'request'; id: number; method: 'query' | 'edit' | 'transact'; input: unknown }
  | { kind: 'command'; command: string; value?: unknown }
  | { kind: 'error'; message: string }
