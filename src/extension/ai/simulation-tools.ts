import type { SimulateInput } from '../../shared/ai.js'
import type { Sessions } from '../sessions.js'
import { type Simulations, simulationSummary } from '../simulations.js'
import { paged, type Register } from './context.js'

export function simulationTools(studio: Sessions, simulations: Simulations, register: Register) {
  register<SimulateInput>('simulate', (input, signal) => simulations.submit(input, signal))
  register<{ caseUri?: string; offset?: number; limit?: number }>('list_simulations', async (input, signal) =>
    paged((await studio.client.call('listSimulations', { uri: input.caseUri }, signal)).map(info => simulationSummary(info)), input))
  register<{ simulationId: string; include?: string[]; retainRecording?: boolean }>('get_simulation', async (input, signal) => {
    if (input.retainRecording !== undefined) await studio.client.call('retainSimulation', { simulationId: input.simulationId, retained: input.retainRecording }, signal)
    return simulationSummary(await studio.client.call('getSimulation', input, signal), input.include)
  })
  register<{ simulationId: string }>('stop_simulation', async (input, signal) => {
    await studio.client.call('stopSimulation', input, signal)
    return simulationSummary(await studio.client.call('getSimulation', input, signal))
  })
}
