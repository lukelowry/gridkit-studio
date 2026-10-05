/** The messages between the extension, its data worker, and its webviews. */

import type { Positions } from '@latkit/diagram'
import type {
  DataBatch,
  Domain,
  FieldSelection,
  Parameters,
  Query,
  QueryBlock,
  RowsBlock,
  RowsQuery,
  Schema,
  Value,
} from '@latkit/model'

import type { Analysis, AnalysisOptions, Comparison, RunTarget } from './analysis.js'
import type { Bindings } from './bindings.js'
import type { SettingsValues } from './preferences.js'
import type { Held } from './streams.js'
import type { ClockState, LoopMode } from './transport.js'

/** A case document at one version. */
export interface Revision {
  uri: string
  version: number
}

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

/** A case element by its `Type/key` id, and optionally one of its fields. */
export interface Element {
  id: string
  field?: string
}

/** An element as a form offers it. */
interface ElementChoice {
  id: string
  name: string
}

export interface Summary extends Revision {
  /** The fields of each type the user can edit. */
  editable: Record<string, string[]>
  name: string
  /** Identifies the case content; a run carries the one it ran on. */
  fingerprint: string
  schema: Schema
  /** The field each type's elements are known by: a bus's `number`, a device's `id`. */
  identities: Record<string, string>
  counts: Record<string, number>
  parameters: Parameters
  issues: Issue[]
  parseMs: number
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

/** GridKit's programs a run can start, by the names the Simulation view gives them. */
export const PROGRAMS = {
  DynamicSimulation: 'Dynamic simulation',
  ContingencyAnalysis: 'Contingency analysis',
} as const
export type Program = keyof typeof PROGRAMS

/** Where GridKit runs: installed here, else in a container of an image. */
export interface GridKit {
  /** Its install folder, or one of its programs; empty finds GridKit on PATH. */
  readonly path: string
  /** An image with GridKit's programs on its PATH, used when GridKit is not installed here; the
   *  user pulls it, never Studio. Empty for none. */
  readonly image: string
  /** The container CLI: docker, podman, or a path to either; empty finds docker, else podman. */
  readonly cli: string
}

/** A running simulation, which the extension stops if the data worker cannot. */
export interface RuntimeProcess {
  pid: number
  executable: string
  /** The container it runs in, which `cli` removes by name. */
  container?: { cli: string; name: string }
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
  /** Bounded solver evidence, retained even when a failed run has no result file. */
  evidence?: string[]
  started: number
  outputs: readonly FieldSelection[]
  /** A ContingencyAnalysis study: the bus each contingency faults, those that failed, how many
   *  have finished, and the one shown. Each contingency shown is a run of its own; GridKit numbers
   *  their files from `offset`, after the case's own faults. */
  contingency?: {
    study: string
    offset: number
    buses: readonly number[]
    failed: readonly number[]
    done: number
    shown: number
  }
}

export interface RunRequest extends Revision {
  values: Record<string, unknown>
  outputs: readonly FieldSelection[]
  gridkit: GridKit
  cacheBytes: number
}

/** What the extension asks of the data worker. */
export interface Requests {
  runs: { input: { uri: string }; output: RunInfo[] }
  preflight: {
    input: RunRequest
    output: {
      values: Record<string, unknown>
      program: Program
      domain: Domain
      scenarios: number
      columns: number
      runtime: string
    }
  }
  analyze: { input: RunTarget & AnalysisOptions; output: Analysis }
  compare: { input: { before: RunTarget; after: RunTarget } & AnalysisOptions; output: Comparison }
  rank: {
    input: RunTarget & AnalysisOptions & { contingencies?: number[] }
    output: {
      study: string
      revision: Revision
      from: string
      field: string
      unit: string | null
      window: Domain
      failed: number[]
      unavailable: number[]
      total: number
      rows: {
        contingency: number
        bus: number
        state: 'measured' | 'failed' | 'unavailable'
        worst?: Analysis['rows'][number]
        snapshot?: Analysis['snapshot']
        message?: string
      }[]
    }
  }
  parse: {
    input: Revision &
      ({ text: string } | { baseVersion: number; changes: readonly (readonly SourceEdit[])[] })
    output: Summary
  }
  complete: { input: { text: string; offset: number }; output: SourceContext['completions'] }
  context: { input: Revision & { offset: number }; output: SourceContext }
  symbols: { input: Revision; output: (SourceRange & { name: string; detail: string })[] }
  locate: { input: Revision & Element; output: SourceRange }
  /** Every element of a type, for a form that picks one. */
  elements: { input: Revision & { type: string }; output: ElementChoice[] }
  transact: { input: Revision & { mutations: readonly Mutation[] }; output: SourceEdit[] }
  /** Places for network vertices that have none of their own. */
  placement: { input: Revision; output: Record<string, Positions> }
  /** Where the diagram's blocks are arranged. */
  presentation: { input: Revision; output: Record<string, Positions> }
  query: {
    input: Revision & { query: Query; run?: string }
    output: QueryBlock[]
  }
  batches: {
    input: Revision & {
      fields?: readonly FieldSelection[]
      run?: string
      window?: Domain
      includeStatic?: boolean
      /** The first run page to send; the view holds those before it. */
      fromPage?: number
    }
    /** How many of the run's pages the stream covered. */
    output: { pages: number }
  }
  /** The next sample time from `at` in `direction`; the run's first or last time when none. */
  step: { input: { run: string; at: number; direction: -1 | 1 }; output: number }
  run: { input: RunRequest; output: RunInfo }
  /** Shows contingency `shown` of the study `run` belongs to, in its place. */
  contingency: { input: { run: string; shown: number }; output: RunInfo }
  stop: { input: { uri: string }; output: null }
  /** Drops the case's runs. */
  clear: { input: { uri: string }; output: null }
  /** Drops the case and its runs. */
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

export type ToWorker = Request | { kind: 'cancel'; id: number } | { kind: 'ack'; id: number }

export type FromWorker =
  | { kind: 'process'; uri: string; process?: RuntimeProcess }
  | { kind: 'result'; id: number; value: unknown }
  | {
      kind: 'error'
      id: number
      message: string
      offset?: number
      length?: number
      /** Whether the error is a defect in Studio; `detail` is its stack. */
      defect?: boolean
      detail?: string
    }
  | { kind: 'batch'; id: number; batches: readonly DataBatch[] }
  | { kind: 'run'; info: RunInfo }
  /** A solver line of the case's run, or, with a level, a line for Studio's log alone. */
  | { kind: 'log'; uri?: string; message: string; level?: 'warn' | 'error' }

export type ViewKind = 'network' | 'diagram' | 'case' | 'monitor' | 'simulation' | 'export'

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

/** Seconds of a run's tail a view holds when the whole run is too large. */
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
  summary?: Summary
  stale?: boolean
  /** Why the source fails to parse; `summary` may hold the last valid revision. */
  error?: string
  selection?: Element
  run?: RunInfo
  /** Whether Run was pressed and GridKit's run has not yet begun. */
  launching?: boolean
  /** What future runs record. */
  outputs?: readonly FieldSelection[]
  plots?: Plot[]
  /** The times the user chose to show in the Monitor; absent, the plots show the whole run. */
  window?: Domain
}

/** How Network and Diagram were last framed, for a video export to keep. */
export interface Cameras {
  network?: unknown
  diagram?: unknown
}

/** Opens a stream of rows and samples, which an `end` of the same `stream` closes. */
export interface Begin {
  kind: 'begin'
  stream: number
  schema: Schema
  revision: Revision
  /** Whether the rows that follow replace the case the view holds. */
  base: boolean
  /** Whether the samples that follow extend those the view holds rather than replace them. */
  append: boolean
  /** The times whose samples the view holds once the stream ends; absent, the whole run. */
  held?: Held
  /** Places for network vertices that have none of their own. */
  placement?: Record<string, Positions>
  /** Where the diagram's blocks are arranged. */
  presentation?: Record<string, Positions>
}

export type ToView =
  | { kind: 'state'; state: ViewState }
  /** The clock settled at send time; `seq` is the last of this view's changes it reflects. */
  | { kind: 'clock'; clock: ClockState; live: boolean; seq: number }
  | Begin
  | { kind: 'batch'; stream: number; sequence: number; batches: readonly DataBatch[] }
  | { kind: 'end'; stream: number }
  /** A request's answer, or why it failed; `defect` marks a defect in Studio, `detail` its stack. */
  | {
      kind: 'reply'
      id: number
      value?: unknown
      error?: string
      defect?: boolean
      detail?: string
    }
  | { kind: 'action'; command: string; value?: unknown }

/** A change a view makes to the clock; its `seq` lets the view recognize the echo. */
export type TransportAction =
  | { action: 'seek' | 'rate'; value: number }
  | { action: 'loop'; value: LoopMode }
  | { action: 'step'; value: 1 | -1 }
  | { action: 'playPause' | 'goLive' }

/** What a view asks of the extension. */
export interface ViewRequests {
  /** Rows of the case, or of the shown run when the query has an `at`. */
  query: { input: RowsQuery; output: RowsBlock[] }
  /** Every element of a type, for a parameter that names one. */
  elements: { input: { type: string }; output: ElementChoice[] }
  transact: {
    input: { version: number; mutations: readonly Mutation[]; label?: string }
    output: void
  }
  /** Asks the user where to save a video: a file handle, or null when they cancel. */
  videoOpen: { input: { name: string; format: 'mp4' | 'webm' }; output: number | null }
  /** Holds what `views` draw over `window`; resolves with their framing once held. */
  videoData: { input: { views: readonly VideoView[]; window: Domain }; output: Cameras }
  videoWrite: { input: { file: number; position: number; bytes: Uint8Array }; output: void }
  /** Finishes the file, or aborts it; resolves to the finished video's path. */
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
  | { kind: 'values'; uri: string; values: Record<string, unknown> }
  | { kind: 'tableState'; table: TableState }
  | { kind: 'busy'; busy: boolean }
  /** Why something in the view failed, which the extension tells the user. */
  | { kind: 'error'; message: string; detail?: string; defect?: boolean }
