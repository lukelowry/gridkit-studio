import type { GridKit } from '../../shared/simulation.js'
export const PROGRAM = 'DynamicSimulation'
export async function available(gridkit: GridKit, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (gridkit.path.trim())
    throw new Error(
      'GridKit Path needs a desktop or remote workspace. Clear it to use the included solver.',
    )
  return { kind: 'wasm' as const, program: PROGRAM }
}
export const runtimeOf = available
export const launch = () => {
  throw new Error('Native execution requires a desktop or remote workspace.')
}
export const terminateRuntime = async () => {}
export const sweepOrphans = async () => {}
