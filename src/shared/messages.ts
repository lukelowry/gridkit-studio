/** The messages between the extension, its worker, and its webviews. */

import type { Camera, Id } from 'latkit'

import type { CaseDefinition, Element, Entity, Field } from './document.js'
export type { Element, Entity } from './document.js'
import type {
  CaseRowsCursor,
  CaseRowsPage,
  ExactSample,
  ExactSampleRequest,
  FieldSelection,
  FramePage,
  FrameRequest,
  TablePage,
  TableRequest,
  TileRequest,
  TimeRange,
  ValueRange,
} from './data.js'
import type { Problem } from './errors.js'
import type { Mappings } from './mappings.js'
import type { Cancel, Reply, Request } from './rpc.js'
import type { ViewSettings } from './settings.js'
import type {
  Results,
  ResultsLayout,
  ResultsProgress,
  Run,
  RunRequest,
  RuntimeProcess,
} from './simulation.js'
import type { Sink } from './study.js'
import type { ClockState } from './transport.js'
export type {
  GridKit,
  Results,
  ResultsLayout,
  ResultsProgress,
  Run,
  RunRequest,
  RuntimeProcess,
} from './simulation.js'

export type Value = number | string | boolean | null | readonly Value[]

/** A case file at one version; the worker keeps the version at which it first saw the content. */
export interface Revision {
  uri: string
  version: number
}

/** A range in a case file, as line and character positions in UTF-16 units like VS Code's. */
export interface SourceRange {
  readonly start: readonly [line: number, character: number]
  readonly end: readonly [line: number, character: number]
}

export interface Issue extends SourceRange {
  message: string
  severity: 'warning' | 'error'
  entity?: Entity
  field?: string
}

export interface Summary extends Revision {
  name: string
  /** Identifies the case content; a run carries the one it ran on. */
  fingerprint: string
  definition: CaseDefinition
  /** The field that identifies each type's elements: a bus's `number`, a device's `id`. */
  identities: Record<string, string>
  counts: Record<string, number>
  /** Per type and output, how many elements list it, plus GridKit's CSV monitor if any. */
  recording: {
    listed: Record<string, Record<string, number>>
    /** Whether any element lists an output, including classes Studio does not know. */
    anything: boolean
    monitor?: Sink
  }
}

export interface Memory {
  heapUsed: number
  arrayBuffers: number
}

interface OfResults {
  results: string
}

/** The case a request reads: a case file revision, or the case some results were read against. */
export type Source = { readonly revision: Revision } | OfResults

export interface WorkerOptions {
  readonly wasmPath: string
  readonly solver?: { readonly worker: string; readonly module: string; readonly wasm: string }
  readonly catalog?: unknown
  /** Bytes of unreferenced results files kept open so they reopen instantly. */
  readonly cacheBytes: number
  /** The folder of decoded results files, which a reopened window reads from. */
  readonly store: string
  /** Results files named by saved sessions, whose stores are kept; the rest are deleted. */
  readonly saved: readonly string[]
  /** A machine-wide record of running GridKit processes, so the next window ends those of a window
   *  that died. Absent where processes end with their window. */
  readonly runs?: string
}

/** The worker's API. It reads case files, runs GridKit and reads results files against a case.
 *  It keeps exactly the results the extension has open, by the extension's ids, until closed. */
export interface WorkerApi {
  /** Reads the file at `uri`. Unchanged content returns the summary at its first version. */
  read: { input: Revision; output: Summary }
  validate: { input: Revision; output: Issue[] }
  /** The element itself if the Network draws its type, else the nearest drawn elements. */
  networkSelection: { input: Revision & { entity: Entity }; output: Entity[] }
  locate: { input: Revision & Element; output: SourceRange }
  caseRows: {
    input: Source & { fields: readonly FieldSelection[]; cursor?: CaseRowsCursor }
    output: CaseRowsPage
  }
  page: { input: { revision: Revision; request: TableRequest }; output: TablePage }
  release: { input: { uri: string }; output: null }
  /** Runs GridKit into `results`; settles when the run ends, and cancelling stops the run. */
  run: { input: RunRequest; output: Run }
  /** Opens the results file at `path` into `results`, read against the case revision. Resolves
   *  once the first frames are read, and keeps reading. */
  open: {
    input: Revision & OfResults & { path: string; solver?: string }
    output: Results
  }
  /** Opens `results` under a second id `as`, as an export does while reading them. */
  share: { input: OfResults & { as: string }; output: Results }
  /** Closes `results`; later requests fail with `results-closed`. The file stays. */
  close: { input: OfResults; output: null }
  configure: { input: { cacheBytes: number }; output: null }
  describe: { input: OfResults; output: Summary }
  frames: { input: FrameRequest; output: FramePage }
  tile: { input: TileRequest; output: Uint8Array }
  sample: { input: ExactSampleRequest; output: ExactSample }
  /** The next sample time from `at` in `direction`; the first or last time when there is none. */
  step: { input: OfResults & { at: number; direction: -1 | 1 }; output: number }
  export: { input: OfResults & { path: string }; output: null }
  /** Counts of what the worker has open, plus the bytes cached. */
  stats: {
    input: Record<string, never>
    output: {
      memory: Memory
      cases: number
      results: number
      files: number
      idle: number
      runs: number
      cacheBytes: number
    }
  }
}

export type WorkerEvent =
  /** The GridKit process started by run `run`, or none once it ends. */
  | { kind: 'process'; run: string; process?: RuntimeProcess }
  | { kind: 'run'; run: Run }
  /** The worker dropped the results because their cached file no longer reads. */
  | { kind: 'lost'; uri: string; results: string }
  /** Read progress, with the layout the first time and again once the header is read. */
  | {
      kind: 'results'
      uri: string
      results: string
      progress: ResultsProgress
      layout?: ResultsLayout
    }
  /** A log line; with `uri`, from that case's run (`raw` is GridKit's text when it differs). */
  | {
      kind: 'log'
      uri?: string
      message: string
      level?: 'error' | 'warn' | 'info' | 'debug'
      raw?: string
    }

export type FromWorker = Reply | WorkerEvent

export type ViewKind = 'network' | 'case' | 'monitor' | 'export'

export type VideoView = 'network' | 'monitor'

/** A Monitor plot of a recorded field, for every element or only `id`, over `range` or fitted. */
export interface Plot extends Field {
  readonly id?: Id
  readonly range?: ValueRange
}

/** The Case panel's state, owned by the session. */
export interface TableState {
  type?: string
  columns?: Record<string, string[]>
  /** Absent: file order. */
  order?: { field: string; direction: 'ascending' | 'descending' }
  filter?: string
  equal?: { field: string; value: string | number | boolean }
}

export interface ViewState {
  uri?: string
  settings?: ViewSettings
  table?: TableState
  mappings?: Mappings
  summary?: Summary
  /** Whether `summary` is out of date: the file changed, or no longer reads. */
  stale?: boolean
  /** Why the file does not read; `summary` may be the last revision that did. */
  error?: string
  selection?: Element
  /** The selection as the Network draws it; absent until resolved. */
  networkSelection?: readonly Entity[]
  results?: Results
  plots?: readonly Plot[]
  /** The Monitor's time window; absent, plots show the whole run. */
  window?: TimeRange
}

/** The Network's camera, and its canvas size in CSS pixels. */
export interface Framing {
  readonly camera: Camera
  readonly size: readonly [number, number]
}

/** Validates a framing sent by a page: a camera with a zoom, and a canvas with a positive size. */
export function framingOf(value: unknown): Framing | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { camera, size } = value as { camera?: unknown; size?: unknown }
  const zoomed =
    !!camera && typeof camera === 'object' && 'zoom' in camera && Number.isFinite(camera.zoom)
  const sized =
    Array.isArray(size) &&
    size.length === 2 &&
    size.every((length) => typeof length === 'number' && length > 0 && Number.isFinite(length))
  return zoomed && sized
    ? { camera: camera as Camera, size: [size[0] as number, size[1] as number] }
    : undefined
}

export type ViewAction = 'fitAll' | 'reloadView' | 'exportImage'

/** The parts of a view's state that changed since last sent, or null once removed. Results omit
 *  their outputs once the page has them: they are the largest part and fixed after the header. */
export type StateChange = {
  [K in keyof ViewState]?:
    | (K extends 'results'
        ? Omit<Results, 'outputs'> & { outputs?: Results['outputs'] }
        : ViewState[K])
    | null
}

/** Tags messages between a view and the extension with the case and generation they belong to.
 *  The generation increments whenever the view switches case or its page reloads, and each side
 *  drops messages from other generations, so nothing reaches the wrong case. Clock changes are
 *  counted from zero in each generation. */
export interface Of {
  readonly uri: string | undefined
  readonly generation: number
}

/** Messages from the extension to a view. All but `visible` are tagged with a generation. */
export type ToView =
  /** Whether VS Code shows the view, regardless of case. */
  | { kind: 'visible'; visible: boolean }
  | ({ of: Of } & (
      | { kind: 'state'; changed: StateChange }
      /** The clock at send time; `seq` is the latest change of this generation it reflects. */
      | { kind: 'clock'; clock: ClockState; seq: number }
      | { kind: 'action'; command: ViewAction }
      | Reply
    ))

/** A change a view makes to the clock; its `seq` lets the view recognize the echo. */
export type TransportAction =
  { action: 'seek'; value: number } | { action: 'step'; value: 1 | -1 } | { action: 'playPause' }

export const revisionOf = ({ uri, version }: Revision): Revision => ({ uri, version })

/** Requests a view makes to the extension; reads are forwarded to the worker. */
export interface ViewApi extends Pick<
  WorkerApi,
  'caseRows' | 'page' | 'frames' | 'tile' | 'sample'
> {
  /** Prompts for where to save a video of `uri`; returns a file handle, or null if cancelled. */
  exportOpen: { input: { uri: string; name: string }; output: number | null }
  /** The Network's last framing, for an export to keep. */
  framing: { input: { uri: string }; output: Framing | null }
  exportWrite: { input: { file: number; bytes: Uint8Array }; output: void }
  exportClose: { input: { file: number; abort?: boolean }; output: string | null }
  /** Prompts for where to save an image of `uri` and saves it; null if cancelled. */
  exportSave: { input: { uri: string; name: string; bytes: Uint8Array }; output: string | null }
  /** Keeps results open under the view's own id while an export reads them. */
  share: { input: OfResults; output: Results }
  unshare: { input: OfResults; output: null }
}

/** Notifications a view sends about its case. */
export type ViewMessage =
  | { kind: 'select'; element: Element | null }
  /** The user opened an element: select it and reveal it in the case file. */
  | { kind: 'open'; element: Element }
  | { kind: 'window'; bounds: TimeRange }
  /** Clears the plot's value range so it fits its values again. */
  | { kind: 'fitValues'; plot: Plot }
  | { kind: 'removePlot'; plot: Plot }
  | { kind: 'framing'; framing: unknown }
  | { kind: 'display'; values: Partial<ViewSettings> }
  | ({ kind: 'transport'; seq: number } & TransportAction)
  | { kind: 'table'; change: Partial<TableState> }
  /** The row count left by the Case panel's filters. */
  | { kind: 'rows'; total: number }
  /** Whether the view is mid-task (an export) and needs to keep its case. */
  | { kind: 'busy'; busy: boolean }

/** Messages from a view to the extension. All but `ready` are tagged with a generation. */
export type FromView =
  | { kind: 'ready' }
  | ({ of: Of } & (
      | ViewMessage
      | Request
      | Cancel
      /** A failure in the view, reported from any generation. */
      | { kind: 'error'; problem: Problem; context?: unknown }
    ))
