import type { Domain, FieldSelection } from '@latkit/model'
import type { Revision } from './messages.js'

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

export interface SimulationInfo {
  id: string
  revision: Revision
  fingerprint: string
  name: string
  state: 'preparing' | 'running' | 'complete' | 'cancelled' | 'failed' | 'interrupted'
  /** Metadata remains discoverable after retention removes its recording. */
  evicted?: boolean
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
  /** Values validated at launch, never the editor's later settings. Absent for legacy imports. */
  configuration?: {
    runtime?:
      | { kind: 'installed'; program: string }
      | { kind: 'container'; cli: string; podman: boolean; image: string }
    values: Record<string, unknown>
    program: Program
    options: readonly { name: string; value: number | string }[]
    addedFaults: readonly {
      bus: number
      start: number
      duration: number
      resistance: number
      reactance: number
    }[]
  }
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

export interface SimulationRequest extends Revision {
  simulationId?: string
  snapshotId?: string
  values: Record<string, unknown>
  outputs: readonly FieldSelection[]
  gridkit: GridKit
  cacheBytes: number
}

