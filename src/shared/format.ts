/** `value` for display; six significant digits hide float conversion noise. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? '—' : value > 0 ? '∞' : '-∞'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6 || magnitude < 1e-4) return value.toExponential(3).replace(/\.?0+e/, 'e')
  return String(Number(value.toPrecision(6)))
}

/** What the user is told of a defect; the log keeps the rest. */
export const UNEXPECTED =
  'GridKit Studio hit an unexpected error. The GridKit Studio log has the details.'

/** Whether `error` is a defect in Studio, such as a TypeError, rather than a sentence for the user.
 *  An error that crossed from the worker says so with `defect`. */
export function defect(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    (error as { defect?: unknown } | null)?.defect === true
  )
}

/** Whether `error` is a cancellation: nothing failed, so nothing is said. */
export function cancelled(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'Canceled'
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
