/** The network's display channels, and which numeric field drives each. */

import type { Id } from 'latkit'

import type { RecordedField } from './data.js'

/** Every channel, vertices' then edges'; `option` is the renderer style option it sets. */
export const CHANNELS = {
  vertexColor: { label: 'Vertex Color', placement: 'vertex', style: 'color', option: 'color' },
  vertexSize: { label: 'Vertex Size', placement: 'vertex', style: 'size', option: 'radius' },
  vertexHeight: {
    label: 'Vertex Height',
    placement: 'vertex',
    style: 'height',
    option: 'elevation',
  },
  edgeColor: { label: 'Edge Color', placement: 'edge', style: 'color', option: 'color' },
  edgeWidth: { label: 'Edge Width', placement: 'edge', style: 'width', option: 'width' },
  edgeDash: { label: 'Edge Dash', placement: 'edge', style: 'dash', option: 'dash' },
} as const

export type Channel = keyof typeof CHANNELS

const ALL = Object.keys(CHANNELS) as Channel[]

export interface FieldRef {
  readonly table: string
  readonly field: string
}

/** A field driving a channel; without a `domain` the renderer measures the values' range. */
interface Binding extends FieldRef {
  readonly domain?: readonly [number, number]
}

export type Bindings = Readonly<Partial<Record<Channel, Binding>>>

/** The field data types that can drive a channel. */
export const NUMERIC: ReadonlySet<unknown> = new Set(['number', 'sampled'])

const sameField = (a: FieldRef | undefined, b: FieldRef): boolean =>
  a !== undefined && a.table === b.table && a.field === b.field

/** Stable-ID coverage of a recorded field, independent of case row order. */
export function recordedRows(
  outputs: readonly RecordedField[],
  field: FieldRef,
  ids?: readonly Id[],
): boolean {
  const matching = outputs.filter(
    (output) => output.table === field.table && output.field === field.field,
  )
  const held = new Set(matching.flatMap((output) => [...output.ids]))
  return ids ? ids.every((id) => held.has(id)) : held.size > 0
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
      next[channel] = { table: field.table, field: field.field, ...(domain && { domain }) }
    else if (sameField(next[channel], field)) delete next[channel]
  }
  return next
}

/** Comma-separated one-word styles: `color, height`. */
export function shortNames(channels: readonly Channel[]): string {
  return channels.map((channel) => CHANNELS[channel].style).join(', ')
}
