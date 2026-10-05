import type {
  DataBatch,
  Domain,
  FieldSelection,
  FieldValues,
  Parameters,
  Query,
  QueryBlock,
  RowsBlock,
  RowsQuery,
  Schema,
  Value,
} from '@latkit/model'

import type { Bindings, Channel, FieldRef } from './bindings.js'
import type { SettingsValues } from './preferences.js'
import type { Held } from './streams.js'
import type { ClockState, LoopMode } from './transport.js'
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
/** An element as a form offers it. */
export interface ElementChoice {
  id: string
  name: string
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
/** A simulation process under way, which its owner stops if the data worker cannot. */
export interface RuntimeProcess {
  pid: number
  executable: string
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
  /** The times the run will cover, once its command says. */
  span?: Domain
  message?: string
  started: number
  outputs: readonly FieldSelection[]
}
export interface RunRequest extends Revision {
  values: Record<string, unknown>
  outputs: readonly FieldSelection[]
  /** Where GridKit is installed; empty finds its DynamicSimulation on PATH. */
  gridkit: string
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
      /** The first of the run's pages to send; the ones before it the view holds already. */
      fromPage?: number
      /** The most the stream may carry. */
      maxBytes?: number
    }
    /** How many of the run's pages the stream covered. */
    output: { pages: number }
  }
  locate: { input: Revision & Element; output: SourceRange }
  /** Every element of a type, by id and name, for a form that picks one. */
  elements: { input: Revision & { type: string }; output: ElementChoice[] }
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
/** Every webview a case shows in. */
export type ViewKind =
  'network' | 'diagram' | 'table' | 'monitor' | 'simulation' | 'bindings' | 'export'
/** A view a video export can draw. */
export type VideoView = 'network' | 'diagram' | 'monitor'
export interface Plot {
  from: string
  field: string
  id?: string
}
export interface TableState {
  type?: string
  fields?: string[]
  filter?: string
}
/** How long a tail of a run a view holds when the whole run is too much to hold, in seconds. */
export const TAIL = 10
export interface ViewState {
  uri?: string
  version?: number
  writable?: boolean
  settings?: SettingsValues
  values?: Record<string, unknown>
  table?: TableState
  diagramEditing?: boolean
  navigate?: boolean
  bindings?: Bindings
  /** The field the Mappings editor is open for. */
  editing?: FieldRef
  /** Open Monitored signals until the Simulation view acknowledges it. */
  choosingSignals?: boolean
  summary?: Summary
  stale?: boolean
  /** The current source could not be parsed; summary may still hold the last valid revision. */
  error?: string
  selection?: Element
  run?: RunInfo
  /** What the runs to come record. */
  outputs?: readonly FieldSelection[]
  plots?: Plot[]
  /** The times the Monitor's reader chose to show; absent, the plots show the run. */
  window?: Domain
}
/** How Network and Diagram were last framed, which a video export keeps. */
export interface Cameras {
  network?: unknown
  diagram?: unknown
}
/** The start of a stream of rows and samples, which ends with its `end`. */
export interface Begin {
  kind: 'begin'
  stream: number
  schema: Schema
  revision: Revision
  /** Whether the rows that follow replace the case the view holds. */
  base: boolean
  /** Whether the samples that follow continue those the view holds, rather than replace them. */
  append: boolean
  /** The times whose samples the view holds once the stream ends; absent, the whole run. */
  held?: Held
  /** Places for a network whose vertices have none of their own. */
  placement?: Record<string, FieldValues>
  /** Where the diagram's blocks were arranged. */
  presentation?: Record<string, FieldValues>
}
export type ToView =
  | { kind: 'state'; state: ViewState }
  /** The clock settled as it is sent, and the newest of this view's own changes it includes. */
  | { kind: 'clock'; clock: ClockState; live: boolean; seq: number }
  | Begin
  | { kind: 'batch'; stream: number; sequence: number; batches: readonly DataBatch[] }
  | { kind: 'end'; stream: number }
  | { kind: 'reply'; id: number; value?: unknown; error?: string }
  | { kind: 'action'; command: string; value?: unknown }
/** A change a view makes to the clock, numbered so the view can tell its own echo. */
export type TransportAction =
  | { action: 'seek' | 'rate'; value: number }
  | { action: 'loop'; value: LoopMode }
  | { action: 'step'; value: 1 | -1 }
  | { action: 'playPause' | 'goLive' }
/** What a view asks of the extension and waits on. */
export interface ViewRequests {
  /** Rows of the case; read at a time, of the run on show. */
  query: { input: RowsQuery; output: RowsBlock[] }
  /** Every element of a type, for a parameter that names one. */
  elements: { input: { type: string }; output: ElementChoice[] }
  edit: { input: Element & { field: string; value: Value; version: number }; output: void }
  transact: {
    input: { version: number; mutations: readonly Mutation[]; label?: string }
    output: void
  }
  /** Choose where a video is written: the file to write, or null when the reader chose nowhere. */
  videoOpen: { input: { name: string; format: 'mp4' | 'webm' }; output: number | null }
  /** Hold what the `views` draw over `window`; resolves, with their framing, once the view does. */
  videoData: { input: { views: readonly VideoView[]; window: Domain }; output: Cameras }
  videoWrite: { input: { file: number; position: number; bytes: Uint8Array }; output: void }
  /** Finish the file, or give it up; resolves to where the finished video is. */
  videoClose: { input: { file: number; abort?: boolean }; output: string | null }
}
export type FromView =
  | { kind: 'ready' }
  | { kind: 'ack'; stream: number; sequence: number }
  | { kind: 'cancel'; id: number }
  | { kind: 'request'; id: number; method: keyof ViewRequests; input: unknown }
  | { kind: 'command'; command: string; value?: unknown }
  | { kind: 'select'; element: Element | null }
  | { kind: 'window'; bounds: Domain }
  | { kind: 'camera'; camera: unknown }
  | ({ kind: 'transport'; seq: number } & TransportAction)
  | { kind: 'bind'; field: FieldRef; channels: readonly Channel[]; domain?: Domain }
  | { kind: 'editing'; field: FieldRef | null }
  /** Every field of `type` the runs to come record. */
  | { kind: 'record'; type: string; select: readonly string[] }
  | { kind: 'values'; uri: string; values: Record<string, unknown> }
  | { kind: 'tableState'; table: TableState }
  | { kind: 'busy'; busy: boolean }
  | { kind: 'notify'; message: string }
  | { kind: 'error'; message: string }
