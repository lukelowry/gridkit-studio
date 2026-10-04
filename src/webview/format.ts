/** Format numbers and failures; from Lattice. Six significant digits hide float conversion noise. */

/** `value` as the views show a number. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? '—' : value > 0 ? '∞' : '-∞'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6 || magnitude < 1e-4) return value.toExponential(3).replace(/\.?0+e/, 'e')
  return String(Number(value.toPrecision(6)))
}

/** What went wrong, as a sentence for the reader. */
export function message(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return typeof error === 'string' ? error : 'Something went wrong.'
}
