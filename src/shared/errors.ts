export interface Failure {
  code: string
  message: string
  [detail: string]: unknown
}

/** Domain errors cross the worker boundary without leaking an implementation stack. */
export function failureOf(error: unknown, aborted = false): Failure {
  const value = error as Record<string, unknown> | null
  return {
    code: typeof value?.code === 'string' ? value.code : aborted ? 'cancelled' : 'operation-failed',
    message: error instanceof Error ? error.message : String(error),
    ...Object.fromEntries(
      ['issues', 'field']
        .filter((key) => value?.[key] !== undefined)
        .map((key) => [key, value![key]]),
    ),
  }
}
