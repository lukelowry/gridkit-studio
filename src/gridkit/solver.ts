/** Parses GridKit's output lines for Studio's log: a level, and the text without the
 *  `[LEVEL][…][…]` prefix. The text is kept verbatim. */

export interface SolverLine {
  level: 'error' | 'warn' | 'info' | 'debug'
  text: string
}

/** The most of one line Studio keeps. A debug dump of a whole case's values is cut there. */
const LINE_CHARS = 4096

/** `line` truncated at LINE_CHARS, noting how many characters were cut. */
export const clipped = (line: string) =>
  line.length <= LINE_CHARS
    ? line
    : `${line.slice(0, LINE_CHARS)}… (${(line.length - LINE_CHARS).toLocaleString()} more characters)`

/** A level, then any bracketed parts, then the text: the four levels GridKit's Logger prints.
 *  SUMMARY and MESSAGE map to info. */
const PRINTED = /^\[(ERROR|WARNING|SUMMARY|MESSAGE)\](?:\[[^\]]*\])*\s*(.*)$/
const LEVELS = { ERROR: 'error', WARNING: 'warn', SUMMARY: 'info', MESSAGE: 'info' } as const

/** Parses one line GridKit printed. A line without a level is info. */
export function readSolverLine(raw: string): SolverLine {
  const printed = PRINTED.exec(raw.trim())
  return printed
    ? { level: LEVELS[printed[1] as keyof typeof LEVELS], text: printed[2]! }
    : { level: 'info', text: raw.trim() }
}

/** A run's line for Studio's log, with the raw line when it differs, or undefined for a blank
 *  line. Later errors restate the first as GridKit unwinds, so once one is `reported` they are
 *  logged as debug. */
export function solverLine(
  raw: string,
  reported: boolean,
): { level: SolverLine['level']; message: string; raw?: string } | undefined {
  const line = clipped(raw)
  const { level, text } = readSolverLine(line)
  if (!text) return undefined
  return {
    level: level === 'error' && reported ? 'debug' : level,
    message: text,
    ...(text !== line.trim() && { raw: line }),
  }
}
