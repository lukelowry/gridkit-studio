/** What Studio reads of a GridKit solver file. GridKit reads everything else in it, so an option, an
 *  event or a fault format it adds needs nothing here. */

import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser'

import { CASE_FILE } from './ids.js'

/** What a .solver.json says that Studio uses: the case it runs, when it ends, and the file it names
 *  for its samples, if any, in its layout. Paths are as written, relative to the solver file's
 *  folder. */
export interface Solver {
  readonly model: string
  readonly tmax: number
  readonly output?: string
  /** A column per variable, or a row per variable and sample. */
  readonly layout: 'wide' | 'long'
}

/** A CSV file GridKit writes samples to. */
export interface Sink {
  readonly file: string
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
    output_layout: written = 'wide',
  } = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  if (typeof model !== 'string' || !CASE_FILE.test(model))
    throw new Error(`${name} names no .case.json in its system_model_file.`)
  if (typeof tmax !== 'number' || !(tmax > 0))
    throw new Error(`${name}: tmax must be a time after 0.`)
  const layout = typeof written === 'string' ? written.toLowerCase() : written
  if (layout !== 'wide' && layout !== 'long')
    throw new Error(`${name}: output_layout must be "wide" or "long".`)
  return { model, tmax, layout, ...(typeof output === 'string' && output && { output }) }
}

/** Where a run writes its samples, by GridKit's rule in parseStudyData: the case's CSV monitor,
 *  which is always wide, when the solver file asks for wide; else its output_file; else that
 *  monitor still, which GridKit writes whatever the layout. */
export function outputOf(name: string, solver: Solver, monitor: Sink | undefined): Sink {
  if (monitor && solver.layout === 'wide') return monitor
  if (solver.output !== undefined) return { file: solver.output }
  if (monitor) return monitor
  throw new Error(
    `${name} names no output_file and its case has no monitor, so a run would write nothing to show.`,
  )
}
