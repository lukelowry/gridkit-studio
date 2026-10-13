/** The messages between the extension, its two workers, and its webviews. */

import type { Layout } from '@latkit/gpu'
import type { Block, Data, Domain, Query, Schema } from '@latkit/model'

import type { Bindings } from './bindings.js'
import type { Problem } from './errors.js'
import type { ViewCommandName } from './ids.js'
import type { SettingsValues } from './preferences.js'
import type { Cancel, Reply, Request } from './rpc.js'
import type {
  Results,
  ResultsLayout,
  ResultsProgress,
  Run,
  RunRequest,
  RuntimeProcess,
} from './simulation.js'
import type { Sink } from './study.js'
import type { ClockState, LoopMode } from './transport.js'
export type {
  GridKit,
  Results,
  ResultsLayout,
  ResultsProgress,
  Run,
  RunRequest,
  RuntimeProcess,
} from './simulation.js'

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
export interface Memory {
  heapUsed: number
  arrayBuffers: number
}

/** The case a request of the results worker reads, at its revision, by its content's fingerprint.
 *  Its source comes only when the worker has yet to read that content. */
export interface CaseSource extends Revision {
  fingerprint: string
  text?: string
}

/** Results the extension holds open, by the id it chose for them. */
export interface OfResults {
  results: string
}

/** What brings the case worker's copy of a document to a revision: its whole text at that revision,
 *  or the changes since the version the worker holds, with the length of the text they make, which
 *  the worker checks: changes applied to any other text are refused. */
export type SourceDelta =
  | { text: string }
  | { baseVersion: number; changes: readonly (readonly SourceEdit[])[]; length: number }

/** What the case worker answers: each open case's source, parsed as the user edits it, and what
 *  the editor and the views read of it. */
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

/** What the extension starts the results worker with. */
export interface ResultsOptions {
  /** How many bytes of decoded frames, and of results files nothing holds, stay read past what
   *  views read now. */
  readonly cacheBytes: number
  /** The folder the results files read are kept in, decoded, so a window opened again reads them
   *  from there. */
  readonly store: string
  /** The results files saved sessions name, whose stores are kept; the rest go. */
  readonly saved: readonly string[]
  /** The folder this machine's windows write their GridKit runs in while they run, so one whose
   *  window died mid-run is ended by the next; none where processes end with their window. */
  readonly runs?: string
}

/** What the results worker answers: GridKit's runs, and the results files Studio reads, each with
 *  the case it was read against. It holds exactly the results the extension holds open, each by
 *  the id the extension chose, until the extension closes them; a case it read goes with the last
 *  results or run that read it. */
export interface ResultsApi {
  /** Runs GridKit and reads what it writes into `results`. The request is the run: it settles when
   *  the run ends, and cancelling it stops the run. */
  run: { input: RunRequest; output: Run }
  /** Reads the GridKit results file at `path` into `results`, for the case, which `solver`'s run
   *  wrote when it names one. It answers once the first frames are read, and the rest are read on. */
  open: {
    input: CaseSource & OfResults & { path: string; solver?: string }
    output: Results
  }
  /** Holds the results `results` hold by `as` too, as an export does while it reads them. */
  share: { input: OfResults & { as: string }; output: Results }
  /** Lets go of `results`; asked of again, they answer `results-closed`. Their file stays. */
  close: { input: OfResults; output: null }
  /** How many bytes of decoded frames stay read past what views read now. */
  configure: { input: { cacheBytes: number }; output: null }
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
  /** What it holds: the results the extension holds, their files, the files resting that
   *  nothing holds, the cases they and the runs under way read, and the bytes kept. */
  stats: {
    input: Record<string, never>
    output: {
      memory: Memory
      results: number
      files: number
      resting: number
      cases: number
      runs: number
      cacheBytes: number
    }
  }
}

/** What a worker tells the extension besides its replies. */
export type WorkerEvent =
  /** The GridKit process the run `run` started, or none once it ends. */
  | { kind: 'process'; run: string; process?: RuntimeProcess }
  /** A run started, or ended. */
  | { kind: 'run'; run: Run }
  /** The results `results` of the case at `uri` are lost: what was kept of their file does not
   *  read, and the worker holds them no more. */
  | { kind: 'lost'; uri: string; results: string }
  /** How far the results `results` have been read: a run's as it writes them, or ones opened;
   *  and their layout, the first time, and again once their header is read. */
  | {
      kind: 'results'
      uri: string
      results: string
      progress: ResultsProgress
      layout?: ResultsLayout
    }
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

/** What the Case panel shows: a type, the columns chosen for each type, the order of its rows, and
 *  its filters. The session alone holds it: commands and the panel change it there. */
export interface TableState {
  type?: string
  columns?: Record<string, string[]>
  /** The field the rows are in the order of, and which way; absent, they are in file order. */
  order?: { field: string; direction: 'ascending' | 'descending' }
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
  anchors?: readonly string[]
  results?: Results
  plots?: readonly Plot[]
  /** The times the user chose to show in the Monitor; absent, the plots show the whole run. */
  window?: Domain
}

/** How Network and Diagram were last framed, for a video export to keep. */
export interface Cameras {
  network?: unknown
  diagram?: unknown
}

/** What a command asks of a view. */
export type ViewAction =
  | 'fit'
  | 'reloadView'
  | 'neighborhood'
  | 'orbit'
  | 'projection'
  | 'diagramEditing'
  | 'arrangeDiagram'
  | 'retryMonitor'
  | 'resetMonitorWindow'
  | 'signalRange'

/** A view's state as it is sent: the summary, the settings and the results' outputs, which weigh
 *  most and change seldom, are left out once the view holds them. */
export type SentState = Omit<ViewState, 'results'> & {
  results?: Omit<Results, 'outputs'> & { outputs?: Results['outputs'] }
}

/** Which showing of which case a message between a view and the extension is of. The extension
 *  counts a showing each time the view follows another case or its page loads, and says which in
 *  every state it sends. Each side drops what the other says of another showing: what a page asked
 *  of a case, or did to it, never reaches the case it shows next, nor the other way. Each showing
 *  counts its changes to the clock from naught. */
export interface Of {
  readonly uri: string | undefined
  readonly showing: number
}

/** What the extension sends a view, each but whether VS Code shows it of a showing. */
export type ToView =
  /** Whether VS Code shows the view: the page's own, of any case. */
  | { kind: 'shown'; shown: boolean }
  | ({ of: Of } & (
      | { kind: 'state'; state: SentState }
      /** The clock settled at send time; `seq` is the last of this showing's changes it reflects. */
      | { kind: 'clock'; clock: ClockState; live: boolean; seq: number }
      | { kind: 'action'; command: ViewAction; value?: unknown }
      | Reply
    ))

/** A change a view makes to the clock; its `seq` lets the view recognize the echo. */
export type TransportAction =
  | { action: 'seek' | 'rate'; value: number }
  | { action: 'loop'; value: LoopMode }
  | { action: 'step'; value: 1 | -1 }
  | { action: 'playPause' | 'goLive' }

/** What a view's request reads: a revision of a case, or the case results were read against, by
 *  the results' id. */
export type Source = { readonly revision: Revision } | OfResults

/** The revision `summary` describes, as a request names it. */
export const revisionOf = ({ uri, version, attachmentId }: Revision): Revision => ({
  uri,
  version,
  ...(attachmentId !== undefined && { attachmentId }),
})

/** What a view asks of the extension. Each request names what it is of: a revision of a case, or
 *  results by their id. */
export interface ViewApi {
  /** Rows of a revision of the case, or, `at` a time, of results. */
  query: { input: Source & { query: Query.Rows }; output: Block.Rows[] }
  /** The static fields a view draws. */
  rows: { input: Source & { fields: readonly Query.Selection[] }; output: Data.RowBatch[] }
  /** Where the diagram's blocks are arranged. */
  presentation: { input: Source; output: Record<string, Layout.Positions> }
  samples: { input: SamplesInput; output: Data.SampleBatch[] }
  /** Edits the revision of the case the view made `mutations` against. */
  transact: {
    input: { revision: Revision; mutations: readonly Mutation[]; label?: string }
    output: void
  }
  /** Asks the user where to save a video of the case at `uri`: a file handle, or null when they
   *  cancel. */
  videoOpen: { input: { uri: string; name: string; format: 'mp4' | 'webm' }; output: number | null }
  /** How the Network and Diagram of the case at `uri` were last framed, for an export to keep. */
  cameras: { input: { uri: string }; output: Cameras }
  videoWrite: { input: { file: number; position: number; bytes: Uint8Array }; output: void }
  /** Finishes the file, or aborts it; resolves to the finished video's path. */
  videoClose: { input: { file: number; abort?: boolean }; output: string | null }
  /** Holds results under an id of the view's own, while it reads them for an export: whatever
   *  shows meanwhile, they stay until it lets go of them, or the view goes. */
  share: { input: OfResults; output: Results }
  unshare: { input: OfResults; output: null }
}

/** What a view says of the case it shows. Its bridge names the showing on each, and the extension
 *  drops one of a showing past. */
export type ViewMessage =
  | { kind: 'command'; command: ViewCommandName; value?: unknown }
  | { kind: 'select'; element: Element | null }
  /** The times the user chose to show in the Monitor. */
  | { kind: 'window'; bounds: Domain }
  | { kind: 'camera'; camera: unknown }
  | ({ kind: 'transport'; seq: number } & TransportAction)
  /** A change the user made in the Case panel to what it shows, which the session takes. */
  | { kind: 'table'; change: Partial<TableState> }
  /** How many rows the Case panel's filters leave, as it last read them. */
  | { kind: 'rows'; shown: number }
  /** Whether the view is mid-task, as an export is, and keeps the case it works on. */
  | { kind: 'busy'; busy: boolean }

/** What a view sends the extension, each but its loading of a showing. */
export type FromView =
  /** The page loaded, and listens. */
  | { kind: 'ready' }
  | ({ of: Of } & (
      | ViewMessage
      | Request
      | Cancel
      /** Why something in the view failed, which the extension tells the user whatever showing
       *  it is of, and what the view was doing, for the log. */
      | { kind: 'error'; problem: Problem; context?: unknown }
    ))
