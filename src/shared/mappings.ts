/** What the Network maps: its display channels, and the numeric field each one shows. */

import type { ValueRange } from './data.js'
import type { Field } from './document.js'

/** Every channel, vertices' then edges'; `option` is the mark option it sets. */
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

/** A field mapped to a channel, over the values `range` gives: without one, over those it holds. */
export interface Mapping extends Field {
  readonly range?: ValueRange
}

export type Mappings = Readonly<Partial<Record<Channel, Mapping>>>

/** The kinds of field a channel can show. */
export const NUMERIC: ReadonlySet<unknown> = new Set(['number', 'sampled'])

const sameField = (a: Field | undefined, b: Field): boolean =>
  a !== undefined && a.table === b.table && a.field === b.field

/** The channels a type drawn as `placement` offers. */
export function channelsFor(placement: 'vertex' | 'edge' | null): readonly Channel[] {
  return ALL.filter((channel) => CHANNELS[channel].placement === placement)
}

/** The values `field` is mapped over; none measures those it holds. */
export function rangeOf(mappings: Mappings, field: Field): ValueRange | undefined {
  return ALL.map((channel) => mappings[channel]).find((mapping) => sameField(mapping, field))?.range
}

/** The channels `field` is mapped to. */
export function channelsOf(mappings: Mappings, field: Field): Channel[] {
  return ALL.filter((channel) => sameField(mappings[channel], field))
}

/** `mappings` with `field` mapped to exactly `channels` of `allowed`: its other allowed channels are
 *  let go of, and the listed ones are taken from whichever fields held them. */
export function mapped(
  mappings: Mappings,
  allowed: readonly Channel[],
  field: Field,
  channels: readonly Channel[],
  range?: ValueRange,
): Mappings {
  const refused = channels.find((channel) => !allowed.includes(channel))
  if (refused !== undefined)
    throw new Error(`${field.field} cannot drive ${CHANNELS[refused].label}.`)
  const next: Partial<Record<Channel, Mapping>> = { ...mappings }
  for (const channel of allowed) {
    if (channels.includes(channel))
      next[channel] = { table: field.table, field: field.field, ...(range && { range }) }
    else if (sameField(next[channel], field)) delete next[channel]
  }
  return next
}

/** Comma-separated one-word styles: `color, height`. */
export function shortNames(channels: readonly Channel[]): string {
  return channels.map((channel) => CHANNELS[channel].style).join(', ')
}
