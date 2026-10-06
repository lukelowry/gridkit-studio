import { dirname, join } from 'node:path'

import { contingencyFile } from '../gridkit/simulation.js'
import type { SimulationInfo } from '../shared/messages.js'
import { Results } from './results.js'

/** Load the contingency that will replace the displayed result, sharing its recording directory. */
export async function sibling(current: Results, shown: number, signal: AbortSignal) {
  const study = current.info.contingency
  if (!study || !Number.isInteger(shown) || shown < 0 || shown >= study.buses.length)
    throw new Error('The run has no such contingency.')
  if (current.info.state !== 'complete')
    throw new Error('Wait for the contingency study to complete.')
  if (study.failed.includes(shown)) throw new Error('That contingency failed; it has no results.')
  const info: SimulationInfo = {
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
    current.ownedDirectory,
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
