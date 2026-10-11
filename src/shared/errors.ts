import { cancelled, defect, detail } from './format.js'

/** Why a request failed, as it crosses from whoever answered to whoever asked: its sentence and
 *  code, and what the log and the editor need besides. */
export interface Problem {
  readonly message: string
  readonly code: string
  /** The stack it was thrown with, for the log. */
  readonly detail?: string
  /** A defect in Studio rather than a sentence for the user. */
  readonly defect?: true
  /** Let go of by whoever asked: nothing failed. */
  readonly cancelled?: true
  /** Where in the source a parse failed. */
  readonly offset?: number
  readonly length?: number
}

/** `error` as it crosses a boundary; `aborted` when whoever asked let go of it. */
export function problemOf(error: unknown, aborted = false): Problem {
  const value = error as { code?: unknown; offset?: unknown; length?: unknown } | null
  const gone = aborted || cancelled(error)
  return {
    message: error instanceof Error ? error.message || error.name : String(error),
    code: typeof value?.code === 'string' ? value.code : gone ? 'cancelled' : 'operation-failed',
    detail: detail(error),
    ...(defect(error) && { defect: true }),
    ...(gone && { cancelled: true }),
    ...(typeof value?.offset === 'number' && { offset: value.offset }),
    ...(typeof value?.length === 'number' && { length: value.length }),
  }
}

/** `problem` as an error again, where it was asked: a cancellation is an AbortError, which nothing
 *  reports. */
export function errorOf({ message, ...rest }: Problem): Error {
  if (rest.cancelled) return new DOMException(message, 'AbortError')
  return Object.assign(new Error(message), rest)
}
