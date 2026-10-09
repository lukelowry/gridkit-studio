import type { Domain, FieldSelection } from '@latkit/model'

import type { Revision } from './messages.js'

/** GridKit's programs Studio runs on a solver file. */
export type Program = 'DynamicSimulation' | 'ContingencyAnalysis'

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

/** A ContingencyAnalysis study: each contingency's bus, those that wrote a file, the faults GridKit
 *  reported failed, as it names them, and the one shown. Contingency `n` faults `buses[n]` and
 *  writes `${base}_${n}${ext}`. */
export interface Study {
  base: string
  ext: string
  buses: readonly number[]
  written: readonly number[]
  failed: readonly string[]
  shown: number
}

/** A GridKit results file read for a case: what the views draw, whether a run writes it or it was
 *  opened. Its frames only grow while a run writes it, and no frame read ever changes. */
export interface Results {
  id: string
  /** The case revision it is read against, and that case's content. */
  revision: Revision
  fingerprint: string
  /** The file's name. */
  name: string
  path: string
  format: 'arrow' | 'csv'
  /** What the file holds, once its header is read. */
  outputs: readonly FieldSelection[]
  frames: number
  domain: Domain
  /** Finite value ranges over every frame read, shared by all views and time windows. */
  domains?: Record<string, Record<string, Domain>>
  /** Frames per chunk, from the header's width, 0 before it is read. Chunk `k` holds frames
   *  `k * chunk` up to `(k + 1) * chunk`, so every process cuts the file alike. */
  chunk: number
  /** Whether more frames may come: a run still writes it, or Studio is still reading through it. */
  growing: boolean
  /** Why reading it stopped before its end, when it did. */
  error?: string
  /** The times a run will cover, as its solver file says. */
  span?: Domain
  /** The study it is one contingency of. */
  contingency?: Study
  started: number
}

/** A run of one of GridKit's programs on a solver file, and what it wrote, as read so far. A study
 *  has written nothing to show until it ends. */
export interface Run {
  id: string
  /** The case it runs. */
  uri: string
  /** What a shell would run, as `DynamicSimulation IEEE39.solver.json`. */
  command: string
  state: 'running' | 'complete' | 'cancelled' | 'failed' | 'interrupted'
  message?: string
  results?: Results
}

/** A run of `program` on a solver file, with what Studio read of it and of its case. */
export interface SimulationRequest extends Revision {
  /** The case's source at its revision, which the results are read against. */
  text: string
  program: Program
  /** The .solver.json GridKit runs, in its folder. */
  solver: string
  /** Where GridKit writes its samples, and how, as the solver file and its case say. */
  output: string
  format: 'arrow' | 'csv'
  /** When the run ends, for its progress. */
  tmax: number
  /** The folder a container mounts. */
  root: string
  gridkit: GridKit
  cacheBytes: number
}
