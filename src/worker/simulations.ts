import type { Case } from '../gridkit/case.js'
import type { SimulationInfo, SimulationRequest } from '../shared/messages.js'

export interface PreparedSimulation {
  request: SimulationRequest
  kase: Case
  info: SimulationInfo
  controller: AbortController
  snapshotId?: string
  completion?: Promise<SimulationInfo>
}

/** Exact simulation identities; display selection never decides which computation is stopped. */
export class Simulations {
  readonly entries = new Map<string, PreparedSimulation>()
  active(uri: string) {
    return [...this.entries.values()].find(
      (value) => value.request.uri === uri && ['preparing', 'running'].includes(value.info.state),
    )
  }
  get(id: string) {
    const entry = this.entries.get(id)
    if (!entry)
      throw Object.assign(new Error('Unknown simulation: ' + id), {
        code: 'simulation-not-found',
        simulationId: id,
      })
    return entry
  }
}
