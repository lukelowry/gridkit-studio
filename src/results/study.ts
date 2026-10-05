import { dirname, join } from 'node:path'

import { contingencyFile } from '../gridkit/simulation.js'
import type { AnalysisOptions } from '../shared/analysis.js'
import type { Requests, RunInfo } from '../shared/messages.js'
import { analysisLimit, analysisSelection, analyze, compareStats } from './analysis.js'
import { Results } from './results.js'

/** Read a study sibling without changing the displayed result. Only a UI switch transfers ownership. */
export async function sibling(current: Results, shown: number, signal: AbortSignal, own = false) {
  const study = current.info.contingency
  if (!study || !Number.isInteger(shown) || shown < 0 || shown >= study.buses.length)
    throw new Error('The run has no such contingency.')
  if (current.info.state !== 'complete')
    throw new Error('Wait for the contingency study to complete.')
  if (study.failed.includes(shown)) throw new Error('That contingency failed; it has no results.')
  const info: RunInfo = {
    ...structuredClone(current.info),
    id: crypto.randomUUID(),
    path: join(dirname(current.info.path), contingencyFile(study.offset + shown)),
    frames: 0,
    domain: [0, 0],
    contingency: { ...study, shown },
  }
  signal.throwIfAborted()
  const result = new Results(
    info,
    current.kase,
    current.fields,
    current.cache,
    own ? current.ownedDirectory : undefined,
  )
  try {
    await result.ingest(
      signal,
      () => true,
      async () => {},
    )
    return result
  } catch (error) {
    result.release()
    throw error
  }
}

export async function rank(
  current: Results,
  input: AnalysisOptions & { contingencies?: number[] },
  signal: AbortSignal,
): Promise<Requests['rank']['output']> {
  const study = current.info.contingency
  if (!study || current.info.state !== 'complete')
    throw new Error('Choose a completed contingency study.')
  const { definition } = analysisSelection(current, input)
  const indices = input.contingencies ?? Array.from({ length: study.buses.length }, (_, n) => n)
  if (
    !indices.length ||
    new Set(indices).size !== indices.length ||
    indices.some((n) => !Number.isInteger(n) || n < 0 || n >= study.buses.length)
  )
    throw new Error('Choose distinct contingency indices from this study.')
  const rows: Requests['rank']['output']['rows'] = []
  const options = { ...input, window: input.window ?? current.info.domain }
  for (const contingency of indices) {
    signal.throwIfAborted()
    const row = { contingency, bus: study.buses[contingency]! }
    if (study.failed.includes(contingency)) {
      rows.push({ ...row, state: 'failed' })
      continue
    }
    let run: Results | undefined
    try {
      run =
        contingency === study.shown ? current : await sibling(current, contingency, signal, false)
      const result = await analyze(run, options, signal)
      rows.push({
        ...row,
        state: result.rows.some((r) => r.valid) ? 'measured' : 'unavailable',
        worst: result.rows[0],
        snapshot: result.snapshot,
        population: result.population,
      })
    } catch (error) {
      signal.throwIfAborted()
      rows.push({
        ...row,
        state: 'unavailable',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
      })
    } finally {
      if (run && run !== current) run.release()
    }
  }
  rows.sort((a, b) =>
    a.worst && b.worst
      ? compareStats(a.worst, b.worst, input.order ?? 'min') || a.contingency - b.contingency
      : a.worst
        ? -1
        : b.worst
          ? 1
          : a.contingency - b.contingency,
  )
  return {
    study: study.study,
    revision: current.info.revision,
    from: input.from,
    field: input.field,
    unit: definition.unit ?? null,
    window: options.window,
    total: rows.length,
    failed: rows.filter((r) => r.state === 'failed').map((r) => r.contingency),
    unavailable: rows.filter((r) => r.state === 'unavailable').map((r) => r.contingency),
    rows: rows.slice(0, analysisLimit(input.limit)),
  }
}
