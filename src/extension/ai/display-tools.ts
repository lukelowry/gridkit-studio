import type { SimulationTarget } from '../../shared/ai.js'
import { showPlot } from '../actions.js'
import type { Sessions } from '../sessions.js'
import { type CaseInput, reference, type Register, resolveCase } from './context.js'

export function displayTools(studio: Sessions, register: Register) {
  register<CaseInput & { componentId: string; field?: string }>(
    'show_component',
    async (input, signal) => {
      const { summary } = await resolveCase(studio, input, signal)
      const element = { id: input.componentId, field: input.field }
      await studio.documents.reveal(input.caseUri, element)
      studio.select(input.caseUri, element)
      return { ...reference(summary), componentId: input.componentId, field: input.field }
    },
  )
  register<
    SimulationTarget & {
      componentType: string
      field: string
      componentId?: string
      timeRange?: readonly [number, number]
    }
  >('plot_results', async (input, signal) => {
    let info = await studio.client.call(
      'getSimulation',
      { simulationId: input.simulationId },
      signal,
    )
    // Validate availability and field selection before changing the user's displayed result.
    await studio.client.call(
      'validateResults',
      {
        uri: info.revision.uri,
        run: input.simulationId,
        contingency: input.contingencyIndex,
        from: input.componentType,
        field: input.field,
        ids: input.componentId ? [input.componentId] : undefined,
        window: input.timeRange,
      },
      signal,
    )
    if (input.contingencyIndex !== undefined)
      info = await studio.client.call(
        'contingency',
        { run: input.simulationId, shown: input.contingencyIndex },
        signal,
      )
    const session = studio.activate(info.revision.uri)
    studio.show(session, info)
    session.window = input.timeRange
    await showPlot(studio, session, {
      from: input.componentType,
      field: input.field,
      id: input.componentId,
    })
    return { simulationId: input.simulationId, displayed: true }
  })
}
