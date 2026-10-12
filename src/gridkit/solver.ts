/** GridKit's own lines, read for Studio's log: a level, and what the line says without the
 *  `[LEVEL][…][…]` GridKit prints before it. What it says is kept as said. */

export interface SolverLine {
  level: 'error' | 'warn' | 'info' | 'debug'
  /** What the line says. */
  text: string
}

/** How much of one line Studio keeps: a debug dump of a whole case's values says no more past it. */
export const LINE_CHARS = 4096

/** `line`, past LINE_CHARS cut short, saying by how much. */
export const clipped = (line: string) =>
  line.length <= LINE_CHARS
    ? line
    : `${line.slice(0, LINE_CHARS)}… (${(line.length - LINE_CHARS).toLocaleString()} more characters)`

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
 *  nothing for a blank line. Errors after the first restate it as GridKit unwinds, so once it has
 *  `said` why, they are details. */
export function solverLine(
  raw: string,
  said: boolean,
): { level: SolverLine['level']; message: string; raw?: string } | undefined {
  const line = clipped(raw)
  const { level, text } = readSolverLine(line)
  if (!text) return undefined
  return {
    level: level === 'error' && said ? 'debug' : level,
    message: text,
    ...(text !== line.trim() && { raw: line }),
  }
}
