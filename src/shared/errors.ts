/** Studio's errors, in one vocabulary on every side: the codes a request fails with, how an error
 *  crosses a channel, which failures are none, and how one is said to the user and to the log. */

import type { Failure } from '@latkit/model'

/** Why a request failed: one of Studio's own reasons, or latkit's. */
export type Code =
  /** Let go of by whoever asked: nothing failed. */
  | 'cancelled'
  /** A newer revision took its place: nothing failed, and the newer one is asked of. */
  | 'superseded'
  /** Studio stopped before it ended. */
  | 'interrupted'
  /** The results worker has yet to read this case, whose source the asker sends again. */
  | 'needs-source'
  /** The case worker's copy is not at the base of the changes it was sent: the asker sends it
   *  whole. */
  | 'stale-source'
  /** The results asked of were closed: nothing failed, and nothing more is asked of them. */
  | 'results-closed'
  /** The results file was written again after it was read. */
  | 'results-changed'
  /** A failure with no code of its own. */
  | 'operation-failed'
  | Failure.Code

/** Why a request failed, as it crosses from whoever answered to whoever asked: its sentence and
 *  code, and what the log and the editor need besides. */
export interface Problem {
  readonly message: string
  readonly code: Code
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

/** An error of `code` saying `message`, with `more` besides: the one way Studio makes one. */
export function problem(code: Code, message: string, more: object = {}): Error & { code: Code } {
  return Object.assign(new Error(message), more, { code })
}

/** Whether `error` failed with `code`. */
export function failedWith(error: unknown, code: Code): boolean {
  return (error as { code?: unknown } | null)?.code === code
}

/** Why a read of a case's revision answers nothing once a newer revision takes its place: the newer
 *  one is asked of. */
export const superseded = () =>
  problem('superseded', 'The document changed. Wait for the current revision.')

/** The codes of failures that are none: whoever asked let go, or another took its place. */
const NONE: readonly Code[] = ['cancelled', 'aborted', 'closed', 'superseded', 'results-closed']
/** The codes of failures a view outlives by starting again: its device or connection came back. */
const PASSING: readonly Code[] = ['device-lost', 'timeout', 'unavailable']

/** Whether `error` is a cancellation, as an AbortError or VS Code's Canceled is. */
export function cancelled(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'Canceled'
}

/** Whether nothing failed: a cancellation, or a failure whose code says it is none. Nothing says
 *  these. */
export function quiet(error: unknown): boolean {
  return cancelled(error) || NONE.some((code) => failedWith(error, code))
}

/** Whether a view that failed with `error` works again once it starts again. */
export function passing(error: unknown): boolean {
  return PASSING.some((code) => failedWith(error, code))
}

/** What the user is told of a defect; the log keeps the rest. */
export const UNEXPECTED =
  'GridKit Studio hit an unexpected error. The GridKit Studio log has the details.'

/** Whether `error` is a defect in Studio, such as a TypeError, rather than a sentence for the user.
 *  An error that crossed from a worker says so with `defect`. */
export function defect(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    (error as { defect?: unknown } | null)?.defect === true
  )
}

/** `error` as a sentence for the user. */
export function message(error: unknown): string {
  if (defect(error)) return UNEXPECTED
  if (error instanceof Error) return error.message || error.name
  return typeof error === 'string' ? error : 'Something went wrong.'
}

/** `error` for the log: the stack it was thrown with, where it has one. */
export function detail(error: unknown): string {
  if (typeof error === 'string') return error
  const carried = (error as { detail?: unknown } | null)?.detail
  if (typeof carried === 'string') return carried
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

/** `error` as it crosses a boundary. */
export function problemOf(error: unknown): Problem {
  const value = error as { code?: unknown; offset?: unknown; length?: unknown } | null
  const gone = cancelled(error)
  return {
    message: error instanceof Error ? error.message || error.name : String(error),
    code:
      typeof value?.code === 'string'
        ? (value.code as Code)
        : gone
          ? 'cancelled'
          : 'operation-failed',
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
