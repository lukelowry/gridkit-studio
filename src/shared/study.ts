/** Reads the few solver file options Studio needs. GridKit reads the rest, so new options, events
 *  or fault formats need no change here. */

import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser'

import { CASE_FILE } from './ids.js'

/** The solver file options Studio uses. Paths are as written, relative to the solver file's
 *  folder. */
export interface Solver {
  readonly model: string
  readonly tmax: number
  readonly output?: string
  /** A .state.json whose bus values GridKit uses instead of the case's. */
  readonly state?: string
  /** Lowercased: `wide` (a column per variable) or `long` (a row per variable and sample). GridKit
   *  reports any other value itself. */
  readonly layout: string
}

/** A CSV file GridKit writes samples to. */
export interface Sink {
  readonly file: string
}

/** Parses the solver file `name`, throwing why it cannot run. */
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
    state_file: state,
  } = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  if (typeof model !== 'string' || !CASE_FILE.test(model))
    throw new Error(`${name} names no .case.json in its system_model_file.`)
  if (typeof tmax !== 'number' || !(tmax > 0))
    throw new Error(`${name}: tmax must be a time after 0.`)
  const layout = String(written).toLowerCase()
  return {
    model,
    tmax,
    layout,
    ...(typeof output === 'string' && output && { output }),
    ...(typeof state === 'string' && state && { state }),
  }
}

/** Where a run writes its samples, following GridKit's parseStudyData: the case's CSV monitor
 *  (always wide) for a wide layout, else output_file, else the monitor regardless of layout. */
export function outputOf(name: string, solver: Solver, monitor: Sink | undefined): Sink {
  if (monitor && solver.layout === 'wide') return monitor
  if (solver.output !== undefined) return { file: solver.output }
  if (monitor) return monitor
  throw new Error(
    `${name} names no output_file and its case has no monitor, so a run would write nothing to show.`,
  )
}
