/** The network styles the bindings give each type. */

import type { Colormap, ColorScale, Scale, ScaleDomain } from '@latkit/gpu'
import type { Data, FieldInput } from '@latkit/model'
import type { EdgeOptions, VertexOptions } from '@latkit/network'

import type { Bindings, Channel, FieldRef } from '../../shared/bindings.js'

/** A sampled field read from a run: its frames, and the values its colors span, which the renderer
 *  measures: over a window of the run, or `auto` for the frame on show. */
export interface Sampled {
  readonly source: Data
  readonly domain: ScaleDomain
}

/** The vertex styles `bindings` give type `type`; see `edgeStylesOf`. */
export function vertexStylesOf(
  bindings: Bindings,
  type: string,
  colormap: Colormap,
  sampledOf: (field: FieldRef) => Sampled | null | undefined,
): Pick<VertexOptions, 'color' | 'sizePx' | 'height'> {
  const { color, scale } = styles(bindings, type, colormap, sampledOf)
  return {
    color: color('vertexColor'),
    sizePx: scale('vertexSize', [2, 7]),
    height: scale('vertexHeight', [0, 1]),
  }
}

/** The edge styles `bindings` give type `type`: each channel's field, read from the case or, for a
 *  sampled field `sampledOf` finds in a run, from that run over the values `sampledOf` says
 *  (`sampledOf` gives null for a sampled field no run on show has, and undefined for a field of the
 *  case). A range the reader set for a binding stands in for the measured one. A channel with no
 *  field clears its style. */
export function edgeStylesOf(
  bindings: Bindings,
  type: string,
  colormap: Colormap,
  sampledOf: (field: FieldRef) => Sampled | null | undefined,
): Pick<EdgeOptions, 'color' | 'dash'> {
  const { color, input } = styles(bindings, type, colormap, sampledOf)
  return { color: color('edgeColor'), dash: input('edgeDash')?.field ?? null }
}

function styles(
  bindings: Bindings,
  type: string,
  colormap: Colormap,
  sampledOf: (field: FieldRef) => Sampled | null | undefined,
) {
  const input = (channel: Channel): { field: FieldInput; domain?: ScaleDomain } | null => {
    const binding = bindings[channel]
    if (binding === undefined || binding.type !== type) return null
    const sampled = sampledOf(binding)
    if (sampled === undefined)
      return { field: binding.field, ...(binding.domain && { domain: binding.domain }) }
    if (sampled === null) return null
    return {
      field: { source: sampled.source, from: type, field: binding.field },
      domain: binding.domain ?? sampled.domain,
    }
  }
  const color = (channel: Channel): ColorScale | null => {
    const found = input(channel)
    return found === null ? null : { ...found, colormap }
  }
  const scale = (channel: Channel, range: readonly [number, number]): Scale | null => {
    const found = input(channel)
    return found === null ? null : { ...found, range }
  }
  return { input, color, scale }
}
