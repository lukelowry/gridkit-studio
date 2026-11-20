/** Network mappings: display channels and the numeric field each one shows. */

import type { ValueRange } from './data.js'
import {
  type CaseDefinition,
  type Field,
  fieldDefinition,
  networkRole,
  sameField,
} from './document.js'

/** Every channel, vertex channels first; `option` is the latkit mark option it sets. */
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

/** A field mapped to a channel, over `range` or, without one, over the field's own values. */
export interface Mapping extends Field {
  readonly range?: ValueRange
}

export type Mappings = Readonly<Partial<Record<Channel, Mapping>>>

export const NUMERIC: ReadonlySet<unknown> = new Set(['number', 'sampled'])

/** Whether a Network channel can show `field`: a number field of a type the Network draws. */
export const mappable = (definition: CaseDefinition, field: Field): boolean =>
  !!networkRole(definition, field.table) &&
  NUMERIC.has(fieldDefinition(definition, field.table, field.field)?.kind)

/** `mappings` without those on a field the case no longer has, or that the Network can no longer
 *  show. The same record when every mapping stays. */
export function keptMappings(definition: CaseDefinition, mappings: Mappings): Mappings {
  const kept = Object.entries(mappings).filter(([, mapping]) => mappable(definition, mapping))
  return kept.length === Object.keys(mappings).length
    ? mappings
    : (Object.fromEntries(kept) as Mappings)
}

/** The channels available to a type drawn as `placement`. */
export function channelsFor(placement: 'vertex' | 'edge' | null): readonly Channel[] {
  return ALL.filter((channel) => CHANNELS[channel].placement === placement)
}

/** The value range `field` is mapped over; undefined uses the field's own values. */
export function rangeOf(mappings: Mappings, field: Field): ValueRange | undefined {
  return ALL.map((channel) => mappings[channel]).find((mapping) => sameField(mapping, field))?.range
}

export function channelsOf(mappings: Mappings, field: Field): Channel[] {
  return ALL.filter((channel) => sameField(mappings[channel], field))
}

/** `mappings` with `field` mapped to exactly `channels` of `allowed`. Its other allowed channels
 *  are cleared, and the listed ones are taken over from other fields. */
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

/** Comma-separated style names: `color, height`. */
export function shortNames(channels: readonly Channel[]): string {
  return channels.map((channel) => CHANNELS[channel].style).join(', ')
}
