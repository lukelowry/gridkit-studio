import type { RecordedField, TimeRange, ValueRange } from './data.js'
import type { Revision } from './messages.js'

/** Where GridKit runs: bundled WebAssembly, or an explicit installation on the workspace host. */
export interface GridKit {
  /** The program a run starts, with the solver file as its only argument. */
  readonly program: string
  /** The install folder or program path; empty selects bundled WebAssembly. */
  readonly path: string
}

/** A running simulation, which the extension stops if the worker cannot. */
export interface RuntimeProcess {
  pid: number
  executable: string
}

/** The fixed part of a results file read against a case, settled once its header is read. */
export interface ResultsLayout {
  /** The case revision it is read against, and that case's content fingerprint. */
  readonly revision: Revision
  readonly fingerprint: string
  readonly name: string
  readonly path: string
  readonly outputs: readonly RecordedField[]
  /** The run's full time span, from its solver file. */
  readonly span?: TimeRange
  readonly solver?: string
}

/** The part of a results file that grows as frames are read. */
export interface ResultsProgress {
  readonly frames: number
  readonly domain: TimeRange
  /** Finite value ranges over every frame read, shared by all views and time windows. */
  readonly domains?: Record<string, Record<string, ValueRange>>
  /** Whether more frames may come: a run is still writing it, or Studio is still reading it. */
  readonly growing: boolean
  /** Why reading stopped before the end, if it did. */
  readonly error?: string
}

/** A results file read against a case, written by a run or opened. Frames are only appended;
 *  frames already read never change. */
export interface Results extends ResultsLayout, ResultsProgress {
  /** The id the extension assigned, valid until it closes the results. */
  readonly id: string
}

/** A run of GridKit's DynamicSimulation on a solver file. */
export interface Run {
  /** The id the extension assigned; every event about the run carries it. */
  id: string
  uri: string
  /** The equivalent shell command, such as `DynamicSimulation IEEE39.solver.json`. */
  command: string
  state: 'running' | 'complete' | 'cancelled' | 'failed' | 'interrupted'
  message?: string
}

/** A request to run a solver file. The revision is the case its results are read against. */
export interface RunRequest extends Revision {
  run: string
  /** The id of the results the run writes, which the extension then owns. */
  results: string
  solver: string
  output: string
  /** The solver file's state file, which GridKit reads along with the case. */
  state?: string
  tmax: number
  gridkit: GridKit
}
