/** GridKit's own lines, read for Studio's log: a level, and what the line says without the
 *  `[LEVEL][…][…]` GridKit prints before it. What it says is kept as said. */

export interface SolverLine {
  level: 'error' | 'warn' | 'info' | 'debug'
  /** What the line says. */
  text: string
}

/** A level, then any bracketed parts, then what the line says. */
const PRINTED = /^\[(ERROR|WARNING|INFO|DEBUG)\](?:\[[^\]]*\])*\s*(.*)$/
const LEVELS = { ERROR: 'error', WARNING: 'warn', INFO: 'info', DEBUG: 'debug' } as const

/** Read one line GridKit printed. A line without a level is GridKit's own account, as info. */
export function readSolverLine(raw: string): SolverLine {
  const printed = PRINTED.exec(raw.trim())
  return printed
    ? { level: LEVELS[printed[1] as keyof typeof LEVELS], text: printed[2]! }
    : { level: 'info', text: raw.trim() }
}

/** A line of a run for Studio's log at its level, with the line as printed when that differs, or
 *  nothing for a blank line. A ContingencyAnalysis's errors are its contingencies' own, so they are
 *  warnings; a simulation's errors after the first restate it as GridKit unwinds, so once it has
 *  `said` why, they are details. */
export function solverLine(
  raw: string,
  program: unknown,
  said: boolean,
): { level: SolverLine['level']; message: string; raw?: string } | undefined {
  const { level, text } = readSolverLine(raw)
  if (!text) return undefined
  return {
    level:
      level !== 'error'
        ? level
        : program === 'ContingencyAnalysis'
          ? 'warn'
          : said
            ? 'debug'
            : 'error',
    message: text,
    ...(text !== raw.trim() && { raw }),
  }
}
