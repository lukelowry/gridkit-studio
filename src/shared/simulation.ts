import type { RecordedField, TimeRange } from './data.js'
import type { CaseSource, Revision } from './messages.js'

/** Where GridKit runs: installed here, else in a container of an image. */
export interface GridKit {
  /** The program a run starts, with the solver file as its one argument. */
  readonly program: string
  /** Its install folder, or its program; empty finds GridKit on PATH. */
  readonly path: string
  /** An image with GridKit's programs on its PATH, used when GridKit is not installed here; the
   *  user pulls it, never Studio. Empty for none. */
  readonly image: string
  /** The container CLI: docker, podman, or a path to either; empty finds docker, else podman. */
  readonly cli: string
}

/** A running simulation, which the extension stops if the results worker cannot. */
export interface RuntimeProcess {
  pid: number
  executable: string
  /** The container it runs in, which `cli` removes by name. */
  container?: { cli: string; name: string }
}

/** What a GridKit results file read for a case is: fixed once its header is read. */
export interface ResultsLayout {
  /** The case revision it is read against, and that case's content. */
  readonly revision: Revision
  readonly fingerprint: string
  /** The file's name. */
  readonly name: string
  readonly path: string
  /** What the file holds, once its header is read. */
  readonly outputs: readonly RecordedField[]
  /** Frames per chunk, from the header's width, 0 before it is read. Chunk `k` holds frames
   *  `k * chunk` up to `(k + 1) * chunk`, so every process cuts the file alike. */
  readonly chunk: number
  /** The times a run will cover, as its solver file says. */
  readonly span?: TimeRange
  /** The solver file whose run wrote it, when one did. */
  readonly solver?: string
}

/** How far a results file is read: what grows as its frames come. */
export interface ResultsProgress {
  readonly frames: number
  readonly domain: TimeRange
  /** Finite value ranges over every frame read, shared by all views and time windows. */
  readonly domains?: Record<string, Record<string, TimeRange>>
  /** Whether more frames may come: a run still writes it, or Studio is still reading through it. */
  readonly growing: boolean
  /** Why reading it stopped before its end, when it did. */
  readonly error?: string
}

/** A GridKit results file read for a case, as the views draw it, whether a run writes it or it was
 *  opened. Its frames only grow while a run writes it, and no frame read ever changes. */
export interface Results extends ResultsLayout, ResultsProgress {
  /** The id the extension chose for it, which it holds the results by until it closes them. */
  readonly id: string
}

/** What of results a view draws: which they are, how far they are read, whether more come, how
 *  they are cut, what they hold, and the times and values they span. Two readings alike in it draw
 *  alike. A file's outputs are fixed once its header is read: whether they are is all that changes,
 *  so their row indexes are never compared or written out again. */
export const drawnOf = (results: Results | undefined) =>
  results && [
    results.id,
    results.frames,
    results.growing,
    results.chunk,
    results.outputs.length,
    results.domain,
    results.span,
    results.domains,
  ]

/** Whether `a` and `b` draw alike. */
export const sameDrawn = (a: Results | undefined, b: Results | undefined): boolean =>
  a === b || (!!a && !!b && JSON.stringify(drawnOf(a)) === JSON.stringify(drawnOf(b)))

/** A run of GridKit's DynamicSimulation on a solver file. */
export interface Run {
  /** The id the extension chose for it, which everything said of the run carries. */
  id: string
  /** The case it runs. */
  uri: string
  /** What a shell would run, as `DynamicSimulation IEEE39.solver.json`. */
  command: string
  state: 'running' | 'complete' | 'cancelled' | 'failed' | 'interrupted'
  message?: string
}

/** A run on a solver file, with what Studio read of it and of its case, which the results are read
 *  against. */
export interface RunRequest extends CaseSource {
  /** The run's id. */
  run: string
  /** The id of the results the run writes, which the extension then holds. */
  results: string
  /** The .solver.json GridKit runs, in its folder. */
  solver: string
  /** Where GridKit writes its samples, as the solver file and its case say. */
  output: string
  /** When the run ends, for its progress. */
  tmax: number
  /** The folder a container mounts. */
  root: string
  gridkit: GridKit
}
