import type { AnalysisInput, SimulationTarget } from '../../shared/ai.js'
import type { AnalysisOptions, SignalOptions } from '../../shared/analysis.js'
import type { Analyses } from '../analyses.js'
import type { Sessions } from '../sessions.js'
import { publicResult, type Register } from './context.js'

const options = (input: Omit<AnalysisInput, 'simulationId'>): AnalysisOptions => ({
  from: input.componentType,
  field: input.field,
  ids: input.componentIds,
  selection: input.selectionId,
  window: input.timeRange,
  metrics: input.metrics,
  order: input.order,
  limit: input.limit,
})
export async function resultTarget(studio: Sessions, input: SimulationTarget, signal: AbortSignal) {
  const info = await studio.client.call(
    'getSimulation',
    { simulationId: input.simulationId },
    signal,
  )
  return { uri: info.revision.uri, run: input.simulationId, contingency: input.contingencyIndex }
}
export function resultTools(studio: Sessions, analyses: Analyses, register: Register) {
  const read = async (
    input: { analysisId: string; offset?: number; limit?: number; waitMs?: number },
    signal: AbortSignal,
  ) => {
    const state = await analyses.read(input, signal)
    if (state.status !== 'complete') return { ...state }
    const findings = await studio.client.call(
      'evidence',
      { evidence: input.analysisId, offset: input.offset, limit: input.limit },
      signal,
    )
    return {
      ...publicResult(findings.summary),
      ...state,
      ...publicResult({ rows: findings.rows }),
      offset: findings.offset,
      total: findings.total,
      nextOffset: findings.nextOffset,
    }
  }
  register<AnalysisInput & { offset?: number }>('analyze_results', async (input, signal) => {
    const target = await resultTarget(studio, input, signal)
    signal.throwIfAborted()
    const receipt = await analyses.start((analysisId, s) =>
      studio.client.call('analyze', { ...target, ...options(input), analysisId }, s),
    )
    return read({ ...input, analysisId: receipt.analysisId }, signal)
  })
  register<
    Omit<AnalysisInput, 'simulationId'> & {
      before: SimulationTarget
      after: SimulationTarget
      offset?: number
    }
  >('compare_results', async (input, signal) => {
    const before = await resultTarget(studio, input.before, signal)
    const after = await resultTarget(studio, input.after, signal)
    signal.throwIfAborted()
    const receipt = await analyses.start((analysisId, s) =>
      studio.client.call('compare', { before, after, ...options(input), analysisId }, s),
    )
    return read({ ...input, analysisId: receipt.analysisId }, signal)
  })
  register<AnalysisInput & { contingencyIndices?: number[]; offset?: number }>(
    'rank_contingencies',
    async (input, signal) => {
      const target = await resultTarget(studio, input, signal)
      signal.throwIfAborted()
      const receipt = await analyses.start((analysisId, s) =>
        studio.client.call(
          'rank',
          { ...target, ...options(input), contingencies: input.contingencyIndices, analysisId },
          s,
        ),
      )
      return read({ ...input, analysisId: receipt.analysisId }, signal)
    },
  )
  register<{ analysisId: string; offset?: number; limit?: number; waitMs?: number }>(
    'get_analysis',
    read,
  )
  register<{ analysisId: string }>('stop_analysis', async (input, signal) => ({
    ...(await analyses.stop(input.analysisId, signal)),
  }))
  register<
    SimulationTarget & {
      componentType: string
      field: string
      componentIds: string[]
      timeRange: readonly [number, number]
      representation: SignalOptions['representation']
    }
  >('read_signal_samples', async (input, signal) => {
    const target = await resultTarget(studio, input, signal)
    const result = await studio.client.call(
      'signals',
      {
        ...target,
        from: input.componentType,
        field: input.field,
        ids: input.componentIds,
        window: input.timeRange,
        representation: input.representation,
      },
      signal,
    )
    return {
      ...publicResult({ ...result }),
      series: result.series.map(({ id, ...series }) => ({ componentId: id, ...series })),
    }
  })
}
