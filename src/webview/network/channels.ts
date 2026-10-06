/** The network channels the bindings give each type. */

import type { Channel, ColorChannel, Colormap, ScaleDomain } from '@latkit/gpu'
import type { Data, FieldInput } from '@latkit/model'

import { type Bindings, CHANNELS, channelsFor, type FieldRef } from '../../shared/bindings.js'

/** A sampled field's run and shared normalization range, independent of the displayed frame. */
export interface Sampled {
  readonly source: Data
  readonly domain: ScaleDomain
}

/** The renderer channels `bindings` give `type`'s vertices or edges. `sampledOf` gives a field's
 *  run, null to leave it out, or undefined to read the case; a range the user set wins. */
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
