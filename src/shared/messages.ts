/** The messages between the extension, its data worker, and its webviews. */

import type { Positions } from '@latkit/gpu'
import type {
  Domain,
  FieldSelection,
  Query,
  QueryBlock,
  RowBatch,
  RowsBlock,
  RowsQuery,
  SampleBatch,
  Schema,
  Value,
} from '@latkit/model'

import type { Results, Run, RuntimeProcess, SimulationRequest, Study } from './simulation.js'
import type { Sink } from './study.js'
export type {
  GridKit,
  Program,
  Results,
  Run,
  RuntimeProcess,
  SimulationRequest,
  Study,
} from './simulation.js'

import type { Bindings } from './bindings.js'
import type { Failure } from './errors.js'
import type { SettingsValues } from './preferences.js'
import type { ClockState, LoopMode } from './transport.js'

/** A case document at one version. */
export interface Revision {
  uri: string
  version: number
  attachmentId?: string
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

export interface Summary extends Revision {
  creation?: Record<string, { keyType: string; required: string[] }>
  /** The fields of each type the user can edit. */
  editable: Record<string, string[]>
  name: string
  /** Identifies the case content; a run carries the one it ran on. */
  fingerprint: string
  schema: Schema
  /** The field each type's elements are known by: a bus's `number`, a device's `id`. */
  identities: Record<string, string>
  counts: Record<string, number>
  /** What the case records: how many of each type's elements list each output, and the monitor
   *  GridKit writes to, if the case has one. */
  recording: { listed: Record<string, Record<string, number>>; monitor?: Sink }
  issues: Issue[]
  /** Pending diagnostics never mean that the model has passed validation. */
  validation: 'pending' | 'complete'
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
  | { kind: 'add'; type: string; key: string | number; fields: Record<string, Value> }
  | { kind: 'remove'; ids: readonly string[] }
  | { kind: 'set'; id: string; field: string; value: Value }
  | { kind: 'move'; id: string; position: readonly [number, number] | null }
  | { kind: 'connect'; from: Element & { field: string }; to: Element | null }
  /** Every element of `type` lists the outputs in `add` and none in `remove`. */
  | { kind: 'record'; type: string; add: readonly string[]; remove: readonly string[] }

/** Frames of one field of a results file that a view asks for: those over `window` it lacks. */
export interface SamplesInput {
  results: string
  /** One field, of the rows a view draws; without rows, of every row the file holds. */
  field: FieldSelection
  /** The times wanted, with the frames either side that reach them. */
  window: Domain
  /** The frames of each chunk the view holds: chunk `k`'s first `held[k]`. */
  held: Readonly<Record<number, number>>
  /** The chunks nearest `at` come first. While a playhead plays at `travel`, the time behind it
   *  counts several times over. */
  near?: { at: number; travel: number }
  /** About the most bytes the reply holds; it holds one chunk's frames at least. */
  bytes: number
}

/** What the extension asks of the data worker. */
export interface Requests {
  /** The case a results file is read against, as it was then. */
  describeResults: { input: { results: string }; output: Summary }
  shutdown: { input: Record<string, never>; output: null }
  /** The nearest elements of the `drawn` types that stand for element `id` in a view. */
  anchors: { input: Revision & { id: string; drawn: readonly string[] }; output: string[] }
  parse: {
    input: Revision &
      ({ text: string } | { baseVersion: number; changes: readonly (readonly SourceEdit[])[] })
    output: Summary
  }
  validate: { input: Revision; output: Issue[] }
  complete: { input: { text: string; offset: number }; output: SourceContext['completions'] }
  context: { input: Revision & { offset: number }; output: SourceContext }
  symbols: { input: Revision; output: (SourceRange & { name: string; detail: string })[] }
  locate: { input: Revision & Element; output: SourceRange }
  transact: { input: Revision & { mutations: readonly Mutation[] }; output: SourceEdit[] }
  /** Where the diagram's blocks are arranged. */
  presentation: { input: Revision & { results?: string }; output: Record<string, Positions> }
  /** Rows of the case, or of the case `results` were read against when the query has an `at`. */
  query: {
    input: Revision & { query: Query; results?: string }
    output: QueryBlock[]
  }
  /** The case's static `fields`, of the case `results` were read against when they are named. */
  rows: {
    input: Revision & { fields: readonly FieldSelection[]; results?: string }
    output: RowBatch[]
  }
  samples: { input: SamplesInput; output: SampleBatch[] }
  /** The next sample time from `at` in `direction`; the first or last time when none. */
  step: { input: { results: string; at: number; direction: -1 | 1 }; output: number }
  /** Runs GridKit and reads what it writes. The request is the run: it settles when the run ends,
   *  and cancelling it stops the run. */
  run: { input: SimulationRequest; output: Run }
  /** A GridKit results file read for the case at its revision, whose source is `text`. It answers
   *  once the first frames are read, and the rest are read on. */
  open: {
    input: Revision & { text: string; path: string; cacheBytes: number; contingency?: Study }
    output: Results
  }
  /** Lets go of the case's results, stopping a run under way. Their files stay. */
  clear: { input: { uri: string }; output: null }
  /** Drops the case and its results. */
  release: { input: { uri: string; attachmentId?: string }; output: null }
  export: { input: { results: string; path: string }; output: null }
  stats: {
    input: Record<string, never>
    output: {
      cacheBytes: number
      sessions: number
      results: number
      memory: { heapUsed: number; arrayBuffers: number }
    }
  }
}

export type Method = keyof Requests

export type Request = {
  [K in Method]: { kind: 'request'; id: number; method: K; input: Requests[K]['input'] }
}[Method]

export type ToWorker = Request | { kind: 'cancel'; id: number }

export type FromWorker =
  | { kind: 'process'; uri: string; process?: RuntimeProcess }
  | { kind: 'result'; id: number; value: unknown }
  | {
      kind: 'error'
      id: number
      problem: Failure
      offset?: number
      length?: number
      /** Whether the error is a defect in Studio; `detail` is its stack. */
      defect?: boolean
      detail?: string
    }
  | { kind: 'run'; run: Run }
  /** How far an opened results file has been read. */
  | { kind: 'results'; uri: string; results: Results }
  /** With `uri`, what a line of that case's run says, and `raw`, the line as GridKit printed it
   *  where they differ. Without, a line of Studio's own. */
  | {
      kind: 'log'
      uri?: string
      message: string
      level?: 'error' | 'warn' | 'info' | 'debug'
      raw?: string
    }

export type ViewKind = 'network' | 'diagram' | 'case' | 'monitor' | 'export'

/** A view a video export can draw. */
export type VideoView = 'network' | 'diagram' | 'monitor'

export interface Plot {
  from: string
  field: string
  id?: string
}

/** What the Case panel shows: a type, the columns chosen for each type, and its filters. */
export interface TableState {
  type?: string
  columns?: Record<string, string[]>
  /** Text the shown rows' names contain. */
  filter?: string
  /** A value of one field every shown row holds. */
  equal?: { field: string; value: string | number | boolean }
}

export interface ViewState {
  uri?: string
  version?: number
  writable?: boolean
  settings?: SettingsValues
  table?: TableState
  diagramEditing?: boolean
  bindings?: Bindings
  summary?: Summary
  stale?: boolean
  /** Why the source fails to parse; `summary` may hold the last valid revision. */
  error?: string
  selection?: Element
  /** The network elements that stand for a selection the network does not draw. */
  anchors?: string[]
  results?: Results
  plots?: Plot[]
  /** The times the user chose to show in the Monitor; absent, the plots show the whole run. */
  window?: Domain
}

/** How Network and Diagram were last framed, for a video export to keep. */
export interface Cameras {
  network?: unknown
  diagram?: unknown
}

export type ToView =
  | { kind: 'state'; state: ViewState }
  /** The clock settled at send time; `seq` is the last of this view's changes it reflects. */
  | { kind: 'clock'; clock: ClockState; live: boolean; seq: number }
  /** A request's answer, or why it failed; `defect` marks a defect in Studio, `detail` its stack,
   *  and `cancelled` a request let go of, where nothing failed. */
  | {
      kind: 'reply'
      id: number
      value?: unknown
      error?: string
      code?: string
      defect?: boolean
      cancelled?: boolean
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
  /** Rows of the case, or of the shown results when the query has an `at`. */
  query: { input: RowsQuery; output: RowsBlock[] }
  /** The static fields a view draws, of a case's revision or of the case results were read
   *  against. */
  rows: { input: Requests['rows']['input']; output: RowBatch[] }
  /** Where the diagram's blocks are arranged in the case at a revision. */
  presentation: { input: Revision & { results?: string }; output: Record<string, Positions> }
  samples: { input: SamplesInput; output: SampleBatch[] }
  transact: {
    input: { version: number; mutations: readonly Mutation[]; label?: string }
    output: void
  }
  /** Asks the user where to save a video: a file handle, or null when they cancel. */
  videoOpen: { input: { name: string; format: 'mp4' | 'webm' }; output: number | null }
  /** How the Network and Diagram were last framed, for an export to keep. */
  cameras: { input: Record<string, never>; output: Cameras }
  videoWrite: { input: { file: number; position: number; bytes: Uint8Array }; output: void }
  /** Finishes the file, or aborts it; resolves to the finished video's path. */
  videoClose: { input: { file: number; abort?: boolean }; output: string | null }
}

export type FromView =
  | { kind: 'ready' }
  | { kind: 'cancel'; id: number }
  | { kind: 'request'; id: number; method: keyof ViewRequests; input: unknown }
  | { kind: 'command'; command: string; value?: unknown }
  | { kind: 'select'; element: Element | null }
  /** The times the user chose to show in the Monitor. */
  | { kind: 'window'; bounds: Domain }
  | { kind: 'camera'; camera: unknown }
  | ({ kind: 'transport'; seq: number } & TransportAction)
  /** What the Case panel shows, and how many rows its filters leave. */
  | { kind: 'tableState'; table: TableState; shown: number }
  | { kind: 'busy'; busy: boolean }
  /** Why something in the view failed, which the extension tells the user. */
  | {
      kind: 'error'
      message: string
      code?: string
      context?: unknown
      detail?: string
      defect?: boolean
    }
