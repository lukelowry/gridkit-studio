/** A case's name without `.case.json`, as the files exported from it are named. */
export const caseStem = (name: string) =>
  name.replace(/(\.case)?\.json$/i, '').replace(/[\\/:*?"<>|]/g, '_')

/** `t` seconds with enough decimals to tell samples apart over `span`, at a width that stays fixed
 *  while it plays. */
export function formatTime(t: number, [from, to]: readonly [number, number]): string {
  return t.toFixed(Math.min(9, Math.max(2, Math.ceil(-Math.log10(to - from || 1)) + 2)))
}

/** `value` for display; six significant digits hide float conversion noise. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? '—' : value > 0 ? '∞' : '-∞'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6 || magnitude < 1e-4) return value.toExponential(3).replace(/\.?0+e/, 'e')
  return String(Number(value.toPrecision(6)))
}
