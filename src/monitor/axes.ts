import type { Domain } from '@latkit/model'

export interface Tick {
  value: number
  position: number
  label: string
}

export interface Axis {
  ticks: Tick[]
  annotation: string
}

/** Display padding never changes samples or the independent color domain. */
export function paddedDomain([min, max]: Domain): Domain {
  const span = max - min
  const padding = min === max ? Math.max(Math.abs(min) * 0.01, 1e-9) : span * 0.05
  return [
    Number.isFinite(min - padding) ? min - padding : min,
    Number.isFinite(max + padding) ? max + padding : max,
  ]
}

export function createAxis(domain: Domain, pixels: number, vertical = false): Axis {
  const [min, max] = domain
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max)
    return { ticks: [], annotation: '' }
  const magnitude = Math.max(Math.abs(min), Math.abs(max))
  const span = max - min
  const smallDifference = Number.isFinite(span) && magnitude / span > 10000
  const offset = smallDifference ? Number(min.toPrecision(8)) : 0
  const scale = smallDifference
    ? 10 ** Math.max(-323, Math.floor(Math.log10(span)))
    : magnitude >= 1e5 || magnitude < 1e-3
      ? 10 ** Math.max(-323, Math.floor(Math.log10(magnitude)))
      : 1
  // Scaling before subtraction keeps extreme but finite domains usable.
  const low = smallDifference ? (min - offset) / scale : min / scale
  const high = smallDifference ? (max - offset) / scale : max / scale
  const intervals = Math.max(1, Math.min(8, Math.floor(pixels / (vertical ? 42 : 90))))
  const rough = (high - low) / intervals
  const power = 10 ** Math.floor(Math.log10(rough))
  const factor = [1, 2, 2.5, 5, 10].reduce((best, value) =>
    Math.abs(Math.log((value * power) / rough)) < Math.abs(Math.log((best * power) / rough))
      ? value
      : best,
  )
  const step = factor * power
  const decimals = Math.max(0, Math.min(12, -Math.floor(Math.log10(step)) + 1))
  const ticks: Tick[] = []
  const first = Math.ceil(low / step - 1e-10)
  const last = Math.floor(high / step + 1e-10)
  for (let index = first; index <= last; index++) {
    const scaled = index * step
    const value = offset + scaled * scale
    ticks.push({
      value,
      position: (scaled - low) / (high - low),
      label: String(Number(scaled.toFixed(decimals))),
    })
  }
  const annotation = offset
    ? `${offset} + tick × ${scale.toExponential(0)}`
    : scale !== 1
      ? `× ${scale.toExponential(0)}`
      : ''
  return { ticks, annotation }
}
