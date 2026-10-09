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

/** A GridKit results file Studio reads for a case: a run's, as GridKit writes it, or one opened. */
export interface SimulationInfo {
  id: string
  revision: Revision
  fingerprint: string
  name: string
  /** What a shell would run for it, as `DynamicSimulation IEEE39.solver.json`. Absent for a file
   *  opened alone. */
  command?: string
  state: 'running' | 'complete' | 'cancelled' | 'failed' | 'interrupted'
  /** The file it reads. */
  path: string
  format: 'arrow' | 'csv'
  frames: number
  domain: Domain
  /** The times the run will cover, as its solver file says. */
  span?: Domain
  /** Finite value ranges over every ingested sample, shared by all views and time windows. */
  domains?: Record<string, Record<string, Domain>>
  message?: string
  started: number
  /** What the file holds, once its header is read. */
  outputs: readonly FieldSelection[]
  contingency?: Study
}

/** A run of `program` on a solver file, with what Studio read of it and of its case. */
export interface SimulationRequest extends Revision {
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
