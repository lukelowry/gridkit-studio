/** What Studio reads of a GridKit study's files. GridKit reads everything else in them, so an
 *  option, an event or a fault format it adds needs nothing here. */

import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser'

import type { Study } from './simulation.js'

/** What a .solver.json says that Studio uses: the case it runs, when it ends, and the file it names
 *  for its samples, if any. Paths are as written, relative to the solver file's folder. */
export interface Solver {
  readonly model: string
  readonly tmax: number
  readonly output?: string
}

/** A file GridKit writes samples to, and how. */
export interface Sink {
  readonly file: string
  readonly format: 'csv' | 'arrow'
}

/** The solver file `name` read from its `text`, or why it can't run. */
export function readSolver(name: string, text: string): Solver {
  const errors: ParseError[] = []
  const json = parse(text, errors, { disallowComments: true, allowTrailingComma: false }) as unknown
  const [error] = errors
  if (error)
    throw new Error(
      `${name}, line ${text.slice(0, error.offset).split('\n').length}: ${printParseErrorCode(error.error)}.`,
    )
  const {
    system_model_file: model,
    tmax,
    output_file: output,
  } = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  if (typeof model !== 'string' || !/\.case\.json$/i.test(model))
    throw new Error(`${name} names no .case.json in its system_model_file.`)
  if (typeof tmax !== 'number' || !(tmax > 0))
    throw new Error(`${name}: tmax must be a time after 0.`)
  return { model, tmax, ...(typeof output === 'string' && output && { output }) }
}

/** Where a run writes its samples, by GridKit's rule in parseStudyData: the case's monitor, else
 *  the solver file's output_file. */
export function outputOf(name: string, solver: Solver, monitor: Sink | undefined): Sink {
  if (monitor) return monitor
  if (solver.output !== undefined) return { file: solver.output, format: 'csv' }
  throw new Error(
    `${name} names no output_file and its case has no monitor, so a run would write nothing to show.`,
  )
}

/** The file contingency `n` of a study writes. */
export const contingencyFile = ({ base, ext }: Pick<Study, 'base' | 'ext'>, n: number): string =>
  `${base}_${n}${ext}`
