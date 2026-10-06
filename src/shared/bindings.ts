/** The network's display channels, and which numeric field drives each. */

import type { FieldSelection } from '@latkit/model'

/** Every channel, vertices' then edges'; `option` is the renderer style option it sets. */
export const CHANNELS = {
  vertexColor: { label: 'Vertex Color', placement: 'vertex', style: 'color', option: 'color' },
  vertexSize: { label: 'Vertex Size', placement: 'vertex', style: 'size', option: 'radiusPx' },
  vertexHeight: { label: 'Vertex Height', placement: 'vertex', style: 'height', option: 'z' },
  edgeColor: { label: 'Edge Color', placement: 'edge', style: 'color', option: 'color' },
  edgeWidth: { label: 'Edge Width', placement: 'edge', style: 'width', option: 'widthPx' },
  edgeDash: { label: 'Edge Dash', placement: 'edge', style: 'dash', option: 'dash' },
} as const

export type Channel = keyof typeof CHANNELS

const ALL = Object.keys(CHANNELS) as Channel[]

export interface FieldRef {
  readonly type: string
  readonly field: string
}

/** A field driving a channel; without a `domain` the renderer measures the values' range. */
interface Binding extends FieldRef {
  readonly domain?: readonly [number, number]
}

export type Bindings = Readonly<Partial<Record<Channel, Binding>>>

/** The field data types that can drive a channel. */
export const NUMERIC: ReadonlySet<unknown> = new Set(['float32', 'float64', 'int32', 'uint32'])

export const sameField = (a: FieldRef | undefined, b: FieldRef): boolean =>
  a !== undefined && a.type === b.type && a.field === b.field

/** Plot exactly the recorded identities; absent rows means the complete component type. */
export function recordedRows(outputs: readonly FieldSelection[], field: FieldRef): FieldSelection['rows'] {
  const selected = outputs.filter(output => output.from === field.type && output.select.includes(field.field))
  if (selected.some(output => !output.rows)) return undefined
  const ids = selected.flatMap(output => output.rows?.kind === 'ids' ? [...output.rows.ids] : [])
  return ids.length ? { kind: 'ids', ids: [...new Set(ids)] } : selected[0]?.rows
}

/** Whether a run with `outputs` records `field` for all `count` rows of its type, as a channel
 *  requires: the network draws every row. */
export function recordedWhole(
  outputs: readonly FieldSelection[],
  count: number,
  field: FieldRef,
): boolean {
  return outputs.some(({ from, select, rows }) => {
    if (from !== field.type || !select.includes(field.field)) return false
    if (rows === undefined) return true
    if (rows.kind === 'ids') return rows.ids.length === count
    if (rows.kind === 'indices') return rows.values.length === count
    return false
  })
}

/** The channels a type drawn as `placement` offers. */
export function channelsFor(placement: 'vertex' | 'edge' | null): readonly Channel[] {
  return ALL.filter((channel) => CHANNELS[channel].placement === placement)
}

/** The value range `field` is mapped over; none measures its values. */
export function domainOf(
  bindings: Bindings,
  field: FieldRef,
): readonly [number, number] | undefined {
  return ALL.map((channel) => bindings[channel]).find((binding) => sameField(binding, field))
    ?.domain
}

/** The channels bound to `field`. */
export function channelsOf(bindings: Bindings, field: FieldRef): Channel[] {
  return ALL.filter((channel) => sameField(bindings[channel], field))
}

/** `bindings` with `field` bound to exactly `channels` of `allowed`: its other allowed channels are
 *  released, and the listed ones are taken from whichever fields held them. */
export function bound(
  bindings: Bindings,
  allowed: readonly Channel[],
  field: FieldRef,
  channels: readonly Channel[],
  domain?: readonly [number, number],
): Bindings {
  const refused = channels.find((channel) => !allowed.includes(channel))
  if (refused !== undefined)
    throw new Error(`${field.field} cannot drive ${CHANNELS[refused].label}.`)
  const next: Partial<Record<Channel, Binding>> = { ...bindings }
  for (const channel of allowed) {
    if (channels.includes(channel))
      next[channel] = { type: field.type, field: field.field, ...(domain && { domain }) }
    else if (sameField(next[channel], field)) delete next[channel]
  }
  return next
}

/** Comma-separated labels: `Vertex Color, Vertex Height`. */
export function fullNames(channels: readonly Channel[]): string {
  return channels.map((channel) => CHANNELS[channel].label).join(', ')
}

/** Comma-separated one-word styles: `color, height`. */
export function shortNames(channels: readonly Channel[]): string {
  return channels.map((channel) => CHANNELS[channel].style).join(', ')
}
