/** Error codes and helpers shared by every process: serializing errors across channels, telling
 *  quiet failures apart, and formatting errors for the user and the log. */

import type { LatkitError } from 'latkit'

import type { SourceRange } from './messages.js'

/** Why a request failed: one of Studio's codes, or latkit's. */
export type Code =
  /** The caller cancelled; not an error. */
  | 'cancelled'
  /** A newer revision replaced the one requested; not an error. */
  | 'superseded'
  /** Studio stopped before the request finished. */
  | 'interrupted'
  /** The results were closed; not an error. */
  | 'results-closed'
  /** The cached results no longer read; their owner reads the file again under a new id. */
  | 'results-lost'
  | 'operation-failed'
  | 'invalid-input'
  | LatkitError['code']

/** A case validation error located by its JSON path. */
export interface SourceProblem {
  readonly code: 'invalid-input'
  readonly message: string
  readonly target: { readonly kind: 'path'; readonly path: readonly [string, number] }
}

export interface SourceError extends Error {
  readonly target?:
    | SourceProblem['target']
    | { readonly kind: 'row'; readonly entity: import('./document.js').Entity }
}

/** A serialized error, as it crosses from the responder back to the caller. */
export interface Problem {
  readonly message: string
  readonly code: Code
  readonly detail?: string
  /** A bug in Studio rather than a message for the user. */
  readonly defect?: true
  readonly cancelled?: true
  readonly range?: SourceRange
  /** Every location where a read failed, in file order. */
  readonly problems?: readonly Placed[]
}

export interface Placed {
  readonly message: string
  readonly range: SourceRange
}

/** An error with `code` and `message`, plus the properties in `more`. */
export function problem(code: Code, message: string, more: object = {}): Error & { code: Code } {
  return Object.assign(new Error(message), more, { code })
}

export function failedWith(error: unknown, code: Code): boolean {
  return (error as { code?: unknown } | null)?.code === code
}

/** The error for a request on a case revision that a newer one replaced. */
export const superseded = () =>
  problem('superseded', 'The case changed. Wait for the current revision.')

/** Codes that are not errors: the caller cancelled, or something replaced the request (as results
 *  read again replace lost ones). */
const QUIET_CODES: readonly Code[] = ['cancelled', 'superseded', 'results-closed', 'results-lost']

/** Whether `error` is a cancellation: an AbortError or VS Code's Canceled. */
export function cancelled(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'Canceled'
}

/** Whether `error` is not a real failure and should not be reported. */
export function quiet(error: unknown): boolean {
  return cancelled(error) || QUIET_CODES.some((code) => failedWith(error, code))
}

/** The message shown for a defect; the log has the details. */
export const UNEXPECTED =
  'GridKit Studio hit an unexpected error. The GridKit Studio log has the details.'

/** Whether `error` is a bug in Studio, such as a TypeError, rather than a message for the user.
 *  Errors from a worker carry the `defect` flag. */
export function defect(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    (error as { defect?: unknown } | null)?.defect === true
  )
}

export function message(error: unknown): string {
  if (defect(error)) return UNEXPECTED
  if (error instanceof Error) return error.message || error.name
  return typeof error === 'string' ? error : 'Something went wrong.'
}

export function detail(error: unknown): string {
  if (typeof error === 'string') return error
  const carried = (error as { detail?: unknown } | null)?.detail
  if (typeof carried === 'string') return carried
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

export function problemOf(error: unknown): Problem {
  const value = error as {
    code?: unknown
    range?: unknown
    problems?: unknown
  } | null
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
    ...(!!value?.range && typeof value.range === 'object' && { range: value.range as SourceRange }),
    ...(Array.isArray(value?.problems) && { problems: value.problems as Placed[] }),
  }
}

/** Deserializes a `Problem`. A cancellation becomes an AbortError, which is never reported. */
export function errorOf({ message, ...rest }: Problem): Error {
  if (rest.cancelled) return new DOMException(message, 'AbortError')
  return Object.assign(new Error(message), rest)
}
