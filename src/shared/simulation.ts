import type { Domain, Query } from '@latkit/model'

import type { CaseSource, Revision } from './messages.js'

/** Where GridKit runs: installed here, else in a container of an image. */
export interface GridKit {
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

/** A GridKit results file read for a case: what the views draw, whether a run writes it or it was
 *  opened. Its frames only grow while a run writes it, and no frame read ever changes. */
export interface Results {
  /** The id the extension chose for it, which it holds the results by until it closes them. */
  id: string
  /** The case revision it is read against, and that case's content. */
  revision: Revision
  fingerprint: string
  /** The file's name. */
  name: string
  path: string
  /** What the file holds, once its header is read. */
  outputs: readonly Query.Selection[]
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
  /** The solver file whose run wrote it, when one did. */
  solver?: string
}

/** A run of GridKit's DynamicSimulation on a solver file. */
export interface Run {
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
