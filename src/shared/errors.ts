export interface Failure {
  code: string
  message: string
  [detail: string]: unknown
}

/** These failures can succeed with a fresh transaction. Invalid data needs a changed demand. */
export function retryable(error: unknown): boolean {
  return ['timeout', 'disconnected', 'io', 'busy', 'conflict', 'protocol'].includes(
    String((error as { code?: unknown } | null)?.code),
  )
}

/** Domain errors cross the worker boundary without leaking an implementation stack. */
export function failureOf(error: unknown, aborted = false): Failure {
  const value = error as Record<string, unknown> | null
  return {
    code: typeof value?.code === 'string' ? value.code : aborted ? 'cancelled' : 'operation-failed',
    message: error instanceof Error ? error.message : String(error),
    ...Object.fromEntries(
      [
        'issues',
        'componentId',
        'field',
        'expectedRevision',
        'actualRevision',
        'simulationId',
        'changeId',
        'coverage',
      ]
        .filter((key) => value?.[key] !== undefined)
        .map((key) => [key, value![key]]),
    ),
  }
}
