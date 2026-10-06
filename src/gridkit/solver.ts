/** GridKit's and SUNDIALS' own lines, read for Studio's log: a level, a plain sentence, and the
 *  solver time a failure names. */

import { formatNumber } from '../shared/format.js'

export interface SolverLine {
  level: 'error' | 'warn' | 'info' | 'debug'
  /** What the line says, in plain words. */
  text: string
  /** The solver time the line names, as SUNDIALS' "At t = …" says it. */
  at?: number
  /** The step size it names, as "h = …". */
  step?: number
  /** The line as printed. */
  raw: string
}

/** `[LEVEL][rank N][file:line][Function] message`, every part after the level optional. */
const PRINTED =
  /^\[(ERROR|WARNING|INFO|DEBUG)\](?:\[rank \d+\])?(?:\[[^\]]+:\d+\])?(?:\[\w+\])?\s*(.*)$/
/** SUNDIALS' "At t = 1.002 and h = 8.5e-10, …" or "At t = 1e-05, …". */
const WHEN = /^At t = ([^\s,]+)(?: and h = ([^\s,]+))?,\s*(.*)$/

/** SUNDIALS' failures, and the IDA flags GridKit names them by, in plain words. */
const PLAIN: readonly (readonly [RegExp, string])[] = [
  [
    /corrector convergence failed|IDA_CONV_FAIL/,
    'the solver could not converge, even at its smallest step',
  ],
  [
    /error test failed|IDA_ERR_FAIL/,
    'the solver could not meet its error tolerance, even at its smallest step',
  ],
  [/mxstep steps taken|IDA_TOO_MUCH_WORK/, 'the solver reached its step limit'],
  [/too much accuracy|IDA_TOO_MUCH_ACC/i, 'the solver could not reach the accuracy asked for'],
  [/linear solver setup failed|IDA_LSETUP_FAIL/, 'the linear solver could not be set up'],
  [/linear solve(?:r)? failed|IDA_LSOLVE_FAIL/, 'the linear solver failed'],
  [/residual (?:function|routine) failed|IDA_RES_FAIL/, 'the model could not be evaluated'],
  [/IDACalcIC|IDA_NO_RECOVERY/, 'consistent initial conditions could not be found'],
]

/** A number as SUNDIALS prints it, or undefined. */
const numeric = (text: string | undefined) => {
  const value = text === undefined ? NaN : Number(text)
  return Number.isFinite(value) ? value : undefined
}

/** `text` as a sentence: capitalized, and ended. */
export const sentence = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.')

/** A line of a run for Studio's log: in plain words at its level, with the line as printed when the
 *  words differ, or nothing for a blank line. A ContingencyAnalysis's errors are its contingencies'
 *  own, so they are warnings; a simulation's errors after the first restate it as GridKit unwinds,
 *  so once it has `said` why, they are details. */
export function solverLine(
  raw: string,
  program: unknown,
  said: boolean,
): { level: SolverLine['level']; message: string; raw?: string } | undefined {
  const line = readSolverLine(raw)
  if (!line.text) return undefined
  const level =
    line.level !== 'error'
      ? line.level
      : program === 'ContingencyAnalysis'
        ? 'warn'
        : said
          ? 'debug'
          : 'error'
  const message =
    line.at === undefined
      ? sentence(line.text)
      : `At t = ${formatNumber(line.at)} s ${line.text}` +
        (line.step === undefined ? '.' : ` (step size ${formatNumber(line.step)} s).`)
  return { level, message, ...(message !== raw.trim() && { raw }) }
}

/** What a run fails with when GridKit stopped on `line`: its plain words, and the time it names. */
export function solverError(line: SolverLine): Error & { at?: number } {
  return Object.assign(new Error(line.text), line.at !== undefined && { at: line.at })
}

/** Read one line GridKit printed. A line without a level is GridKit's own account, as info. */
export function readSolverLine(raw: string): SolverLine {
  const printed = PRINTED.exec(raw.trim())
  if (!printed) return { level: 'info', text: raw.trim(), raw }
  const [, level, rest] = printed
  const when = WHEN.exec(rest!)
  const said = when?.[3] ?? rest!
  const at = numeric(when?.[1])
  const step = numeric(when?.[2])
  return {
    level:
      level === 'ERROR'
        ? 'error'
        : level === 'WARNING'
          ? 'warn'
          : level === 'INFO'
            ? 'info'
            : 'debug',
    text: PLAIN.find(([pattern]) => pattern.test(said))?.[1] ?? said,
    ...(at !== undefined && { at }),
    ...(step !== undefined && { step }),
    raw,
  }
}
