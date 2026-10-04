/**
 * The network's display channels a field can drive, and how the Mappings panel names them: in full
 * where there is room (`Vertex Color`), and by one word each in a dense row (`color`).
 */

import type { FieldSelection } from '@latkit/model'

/** Every channel, in the order the panel lists them. */
export const CHANNELS = {
  vertexColor: { label: 'Vertex Color', placement: 'vertex', style: 'color' },
  vertexSize: { label: 'Vertex Size', placement: 'vertex', style: 'size' },
  vertexHeight: { label: 'Vertex Height', placement: 'vertex', style: 'height' },
  edgeColor: { label: 'Edge Color', placement: 'edge', style: 'color' },
  edgeDash: { label: 'Edge Dash', placement: 'edge', style: 'dash' },
} as const

/** A channel: one style of the vertices or the edges. */
export type Channel = keyof typeof CHANNELS

/** A field of a network type: the type, and the field's name there. */
export interface FieldRef {
  readonly type: string
  readonly field: string
}

/** A field driving a channel, over the values `domain` names; without one the renderer measures. */
export interface Binding extends FieldRef {
  readonly domain?: readonly [number, number]
}

/** The field each channel is drawn from; an absent channel is unbound. */
export type Bindings = Readonly<Partial<Record<Channel, Binding>>>

/** The numeric types a field drives a channel with. */
export const NUMERIC: ReadonlySet<unknown> = new Set(['float32', 'float64', 'int32', 'uint32'])

/** Whether `a` and `b` name the same field. */
export const sameField = (a: FieldRef | undefined, b: FieldRef): boolean =>
  a !== undefined && a.type === b.type && a.field === b.field

/** Whether a run with `outputs` recorded `field` for every one of its type's `count` rows, as a
 *  field that drives a channel must be: the network draws all of them. */
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

/** The channels the fields of a type placed as `placement` can drive. */
export function channelsFor(placement: 'vertex' | 'edge' | null): readonly Channel[] {
  return (Object.keys(CHANNELS) as Channel[]).filter(
    (channel) => CHANNELS[channel].placement === placement,
  )
}

/** The channels `field` drives now. */
export function channelsOf(bindings: Bindings, field: FieldRef): Channel[] {
  return (Object.keys(CHANNELS) as Channel[]).filter((channel) =>
    sameField(bindings[channel], field),
  )
}

/** `bindings` with `field` driving exactly `channels` of the `allowed` ones: those it drove and are
 *  not listed are released, and the listed ones are taken from whichever fields drove them. */
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

/** `channels` by their full names, in one line: `Vertex Color, Vertex Height`. */
export function fullNames(channels: readonly Channel[]): string {
  return channels.map((channel) => CHANNELS[channel].label).join(', ')
}

/** `channels` by one word each, in one line: `color, height`; empty for none. */
export function shortNames(channels: readonly Channel[]): string {
  return channels.map((channel) => CHANNELS[channel].style).join(', ')
}
