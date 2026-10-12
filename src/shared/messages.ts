/** The messages between the extension, its two workers, and its webviews. */

import type { Layout } from '@latkit/gpu'
import type { Block, Data, Domain, Query, Schema } from '@latkit/model'

import type { Cancel, Reply, Request } from './rpc.js'
import type { Results, Run, RunRequest, RuntimeProcess, Study } from './simulation.js'
import type { Sink } from './study.js'
export type {
  GridKit,
  Program,
  Results,
  Run,
  RunRequest,
  RuntimeProcess,
  Study,
} from './simulation.js'

import type { Bindings } from './bindings.js'
import type { SettingsValues } from './preferences.js'
import type { ClockState, LoopMode } from './transport.js'

/** A JSON value of a case record: what a cell shows and an edit writes. */
export type Value = number | string | boolean | null | readonly Value[]

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

/** An entry of a case's outline: an array of its file, holding its records, or one of them. */
export interface CaseSymbol extends SourceRange {
  name: string
  detail: string
  children?: CaseSymbol[]
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
  field: Query.Selection
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

/** How much memory a worker holds. */
interface Memory {
  heapUsed: number
  arrayBuffers: number
}

/** The case a request of the results worker reads, at its revision, by its content's fingerprint.
 *  Its source comes only when the worker has yet to read that content. */
export interface CaseSource extends Revision {
  fingerprint: string
  text?: string
}

/** The results a request reads, by their id. */
interface OfResults {
  results: string
}

/** What the case worker answers: each open case's source, parsed as the user edits it, and what
 *  the editor and the views read of it. */
/** What brings the case worker's copy of a document to a revision: its whole text, or the changes
 *  since the version the worker holds. */
export type SourceDelta =
  { text: string } | { baseVersion: number; changes: readonly (readonly SourceEdit[])[] }

export interface CaseApi {
  parse: {
    input: Revision & SourceDelta
    output: Summary
  }
  validate: { input: Revision; output: Issue[] }
  /** The nearest elements of the `drawn` types that stand for element `id` in a view. */
  anchors: { input: Revision & { id: string; drawn: readonly string[] }; output: string[] }
  complete: {
    input: Revision & SourceDelta & { offset: number }
    output: SourceContext['completions']
  }
  context: { input: Revision & { offset: number }; output: SourceContext }
  /** The outline, listing up to `limit` records. */
  symbols: { input: Revision & { limit: number }; output: CaseSymbol[] }
  locate: { input: Revision & Element; output: SourceRange }
  transact: { input: Revision & { mutations: readonly Mutation[] }; output: SourceEdit[] }
  /** Where the diagram's blocks are arranged. */
  presentation: { input: Revision; output: Record<string, Layout.Positions> }
  /** Rows of the case. */
  query: { input: Revision & { query: Query }; output: Block[] }
  /** The case's static `fields`. */
  rows: { input: Revision & { fields: readonly Query.Selection[] }; output: Data.RowBatch[] }
  /** Drops the case. */
  release: { input: { uri: string; attachmentId?: string }; output: null }
  stats: { input: Record<string, never>; output: { memory: Memory; cases: number } }
}

/** What the results worker answers: GridKit's runs, and the results files Studio reads, each with
 *  the case it was read against. */
export interface ResultsApi {
  /** Runs GridKit and reads what it writes. The request is the run: it settles when the run ends,
   *  and cancelling it stops the run. */
  run: { input: RunRequest; output: Run }
  /** A GridKit results file read for the case, which `solver`'s run wrote when it names one. It
   *  answers once the first frames are read, and the rest are read on. */
  open: {
    input: CaseSource & { path: string; solver?: string; cacheBytes: number; contingency?: Study }
    output: Results
  }
  /** The case the results were read against, as it was then. */
  describe: { input: OfResults; output: Summary }
  /** Rows of the case the results were read against, at a time of theirs when the query has an
   *  `at`. */
  query: { input: OfResults & { query: Query }; output: Block[] }
  /** The static `fields` of the case the results were read against. */
  rows: { input: OfResults & { fields: readonly Query.Selection[] }; output: Data.RowBatch[] }
  /** Where the diagram's blocks are arranged in the case the results were read against. */
  presentation: { input: OfResults; output: Record<string, Layout.Positions> }
  samples: { input: SamplesInput; output: Data.SampleBatch[] }
  /** The next sample time from `at` in `direction`; the first or last time when none. */
  step: { input: OfResults & { at: number; direction: -1 | 1 }; output: number }
  export: { input: OfResults & { path: string }; output: null }
  /** Lets go of the case's results, stopping a run under way. Their files stay. */
  clear: { input: { uri: string }; output: null }
  /** Stops every run under way, each interrupted. */
  shutdown: { input: Record<string, never>; output: null }
  stats: {
    input: Record<string, never>
    output: { memory: Memory; files: number; cacheBytes: number }
  }
}

/** What a worker tells the extension besides its replies. */
export type WorkerEvent =
  /** The GridKit process a case's run started, or none once it ends. */
  | { kind: 'process'; uri: string; process?: RuntimeProcess }
  /** A run started, began to write its results, or ended. */
  | { kind: 'run'; run: Run }
  /** How far a results file has been read: a run's as it writes it, or one opened. */
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

export type FromWorker = Reply | WorkerEvent

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
  | Reply
  | { kind: 'action'; command: string; value?: unknown }

/** A change a view makes to the clock; its `seq` lets the view recognize the echo. */
export type TransportAction =
  | { action: 'seek' | 'rate'; value: number }
  | { action: 'loop'; value: LoopMode }
  | { action: 'step'; value: 1 | -1 }
  | { action: 'playPause' | 'goLive' }

/** What a view asks of the extension. */
export interface ViewApi {
  /** Rows of the case, or of the shown results when the query has an `at`. */
  query: { input: Query.Rows; output: Block.Rows[] }
  /** The static fields a view draws, of a case's revision or of the case results were read
   *  against. */
  rows: {
    input: CaseApi['rows']['input'] | ResultsApi['rows']['input']
    output: Data.RowBatch[]
  }
  /** Where the diagram's blocks are arranged, in a case's revision or in the case results were
   *  read against. */
  presentation: { input: Revision | OfResults; output: Record<string, Layout.Positions> }
  samples: { input: SamplesInput; output: Data.SampleBatch[] }
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
  | Request
  | Cancel
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
