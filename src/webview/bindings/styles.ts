/** The network channels the bindings give each type. */

import type { Channel, ColorChannel, Colormap, ScaleDomain } from '@latkit/gpu'
import type { Data, FieldInput } from '@latkit/model'

import { type Bindings, CHANNELS, channelsFor, type FieldRef } from '../../shared/bindings.js'

/** A sampled field read from a run: its frames, and the values its colors span, which the renderer
 *  measures: over a window of the run, or `auto` for the frame on show. */
export interface Sampled {
  readonly source: Data
  readonly domain: ScaleDomain
}

/** The channels `bindings` give `type`'s vertices or edges, by the renderer's option: each bound
 *  field read from the case or, for a sampled field `sampledOf` finds in a run, from that run over
 *  the values `sampledOf` says (`sampledOf` gives null for a sampled field no run on show has, and
 *  undefined for a field of the case). A range the reader set stands in for the measured one, and
 *  each channel spans the renderer's own range. A channel with no field is left out. */
export function channelsOf(
  bindings: Bindings,
  type: string,
  placement: 'vertex' | 'edge',
  colormap: Colormap,
  sampledOf: (field: FieldRef) => Sampled | null | undefined,
): Record<string, Channel | ColorChannel> {
  const channels: Record<string, Channel | ColorChannel> = {}
  for (const channel of channelsFor(placement)) {
    const binding = bindings[channel]
    if (binding === undefined || binding.type !== type) continue
    const sampled = sampledOf(binding)
    if (sampled === null) continue
    const field: FieldInput =
      sampled === undefined
        ? binding.field
        : { source: sampled.source, from: type, field: binding.field }
    const domain = binding.domain ?? sampled?.domain
    const { option } = CHANNELS[channel]
    channels[option] =
      option === 'color'
        ? { field, colormap, ...(domain && { domain }) }
        : option === 'dash' || domain === undefined
          ? field
          : { field, domain }
  }
  return channels
}
