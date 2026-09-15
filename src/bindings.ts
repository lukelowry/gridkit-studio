import type { Domain, FieldRef, Model } from '@latkit/model'
import { type Channel, CHANNELS } from '@latkit/network'

// Position, masks, and shader inputs belong to layout/interaction, not scalar display bindings.
export type DisplayChannel = {
  [K in Channel]: (typeof CHANNELS)[K]['map'] extends 'colormap' | 'height' | 'size' | 'dash'
    ? K
    : never
}[Channel]
export const DISPLAY_CHANNELS = (Object.keys(CHANNELS) as Channel[]).filter(
  (key): key is DisplayChannel =>
    ['colormap', 'height', 'size', 'dash'].includes(CHANNELS[key].map),
)
export const isDisplayChannel = (value: unknown): value is DisplayChannel =>
  DISPLAY_CHANNELS.includes(value as DisplayChannel)
export interface Binding {
  readonly field: FieldRef
  readonly range?: Domain
}
export type Bindings = Readonly<Partial<Record<DisplayChannel, Binding>>>
// Channel eligibility follows topology ownership; CaseFields validates field availability.
export const channelsFor = (model: Model, field: FieldRef): DisplayChannel[] =>
  DISPLAY_CHANNELS.filter((channel) => model.owners[CHANNELS[channel].scope] === field.classId)
export function validateBinding(model: Model, channel: DisplayChannel, binding: Binding): void {
  if (!channelsFor(model, binding.field).includes(channel))
    throw new Error('Only direct bus or branch numeric fields can drive this channel.')
  if (
    binding.range &&
    (!CHANNELS[channel].normalized ||
      binding.range.length !== 2 ||
      !binding.range.every(Number.isFinite) ||
      binding.range[0] >= binding.range[1])
  ) {
    throw new Error('A normalized channel range must contain two finite, increasing numbers.')
  }
}
export function extent(values: Float64Array): Domain {
  let min = Infinity
  let max = -Infinity
  for (const value of values)
    if (Number.isFinite(value)) {
      min = Math.min(min, value)
      max = Math.max(max, value)
    }
  return min === Infinity ? [0, 1] : [min, max]
}
// Normalize in f64 before uploading. This retains small differences and avoids f32 overflow.
// Constants map to the midpoint; absent colors remain missing; other absent values map to zero (solid for dash).
export function renderValues(
  values: Float64Array,
  channel: DisplayChannel,
  range?: Domain,
): Float32Array {
  const [min, max] = range ?? extent(values)
  return Float32Array.from(values, (value) => {
    if (!Number.isFinite(value)) return CHANNELS[channel].map === 'colormap' ? NaN : 0
    if (!CHANNELS[channel].normalized) return value > 0 ? Math.min(value, 3.4028234663852886e38) : 0
    if (min === max) return 0.5
    const scale = Math.max(Math.abs(min), Math.abs(max), 1)
    return Math.max(0, Math.min(1, (value / scale - min / scale) / (max / scale - min / scale)))
  })
}
