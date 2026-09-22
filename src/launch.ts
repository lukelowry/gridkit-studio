import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { validateSimulationCase } from './gridkit/preflight.js'
import { parseSolver, type SolverInput } from './gridkit/solver.js'
import { type Case, validate } from './gridkit/validate.js'

export interface SolverLaunch {
  solver: string
  case: string
  output: string
  outputs: readonly string[]
  cwd: string
  root: string
  input: SolverInput
  raw: Case
  assertCurrent?: () => void
  cleanup?: () => Promise<void>
  dispose?: () => Promise<void>
  publish?: () => Promise<void>
  sourceText?: Readonly<{ solver: string; case: string }>
  provenance?: Readonly<Record<string, unknown>>
}
export const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel)
}
export async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return resolve(await realpath(dirname(path)), path.split(/[\\/]/).at(-1)!)
  }
}
export async function resolveSolver(
  path: string,
  root: string,
  outputMode: 'direct' | 'staged' = 'direct',
): Promise<SolverLaunch> {
  if (!/\.solver\.json$/i.test(path)) throw new Error('Choose a .solver.json file.')
  const solver = await realpath(path)
  const cwd = dirname(solver)
  const mount = await realpath(root)
  const solverText = await readFile(solver, 'utf8')
  const input = parseSolver(JSON.parse(solverText))
  const casePath = await realpath(resolve(cwd, input.system_model_file))
  const caseText = await readFile(casePath, 'utf8')
  const raw = validate(JSON.parse(caseText))
  const columns = validateSimulationCase(raw)
  if (
    Array.isArray(input.error_tolerance) &&
    input.error_tolerance.length > 1 &&
    input.error_tolerance.length !== columns
  )
    throw new Error(
      'error_tolerance must contain one value or exactly ' +
        columns +
        ' monitored values (excluding time).',
    )
  const faults = raw.devices.filter((device) => device.class === 'BusFault')
  for (const event of input.events)
    if (!faults[event.element_id])
      throw new Error(
        `Event references missing BusFault index ${event.element_id}. The index is its position among the case's fault devices.`,
      )
  const sinks = raw.monitors ?? []
  if (
    sinks.some(
      (sink) =>
        sink.format.toLowerCase() !== 'csv' || (sink.delim !== undefined && sink.delim !== ','),
    )
  )
    throw new Error('Studio runs require comma-delimited CSV monitors.')
  const sinkPaths = sinks.map((sink) => sink.file_name).filter((path): path is string => !!path)
  // The last CSV sink wins upstream, including a sink without a filename.
  const modelOutput = sinks.at(-1)?.file_name
  const monitor = modelOutput || input.output_file
  if (!monitor)
    throw new Error('Set output_file in the solver or a CSV file_name in the case monitors.')
  if (outputMode === 'direct' && modelOutput && input.output_file) {
    const alias = resolve(cwd, input.output_file)
    const target = resolve(cwd, modelOutput)
    if (relative(alias, target) === '')
      throw new Error(
        'Remove output_file: it duplicates the case monitor filename and GridKit would create a self-referencing symlink.',
      )
    const info = await lstat(alias).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (info && (!info.isSymbolicLink() || (await readlink(alias)) !== modelOutput))
      throw new Error(
        'output_file must be an unused path or a symlink to the case monitor filename. Remove the redundant output_file or choose another path.',
      )
    // GridKit stores the sink spelling as the link target, relative to the alias directory.
    if (relative(resolve(dirname(alias), modelOutput), target) !== '')
      throw new Error(
        'output_file would link to the wrong directory. Omit it when the case already names its monitor file.',
      )
  }
  const output = await canonical(resolve(cwd, monitor))
  const outputs = [
    ...new Set(
      await Promise.all(
        [...sinkPaths, ...(input.output_file ? [input.output_file] : [])].map((path) =>
          canonical(resolve(cwd, path)),
        ),
      ),
    ),
  ]
  const reference = input.reference_file
    ? await realpath(resolve(cwd, input.reference_file))
    : undefined
  for (const file of [solver, casePath, ...outputs, ...(reference ? [reference] : [])])
    if (!within(mount, file))
      throw new Error('Solver inputs and outputs must be inside the same workspace folder.')
  for (const file of outputs)
    if ([solver, casePath, reference].includes(file))
      throw new Error('A monitor output cannot overwrite a solver, case, or reference input.')
  for (const file of outputs) {
    const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (info && !info.isFile()) throw new Error('Monitor output must be a regular file.')
  }
  return {
    solver,
    case: casePath,
    output,
    outputs,
    cwd,
    root: mount,
    input,
    raw,
    sourceText: Object.freeze({ solver: solverText, case: caseText }),
  }
}
