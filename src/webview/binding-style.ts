import type { Colormap, ColorScale, Scale, ScaleDomain } from '@latkit/gpu'
import type { Data, FieldInput } from '@latkit/model'
import type { EdgeOptions, VertexOptions } from '@latkit/network'

import type { Binding as FieldRef, Bindings as Sources, Channel } from '../bindings.js'
interface Sampled {
  source: Data
  domain: ScaleDomain
}
/** Adapted from Lattice 8100c24e binding styles. */
/** The vertex styles `sources` give type `type`; see `edgeStylesOf`. */
export function vertexStylesOf(
  sources: Sources,
  type: string,
  colormap: Colormap,
  sampledOf: (field: FieldRef) => Sampled | null | undefined,
): Pick<VertexOptions, 'color' | 'sizePx' | 'height'> {
  const { color, scale } = styles(sources, type, colormap, sampledOf)
  return {
    color: color('vertexColor'),
    sizePx: scale('vertexSize', [2, 12]),
    height: scale('vertexHeight', [0, 1]),
  }
}

/** The edge styles `sources` give type `type`: each channel's field, read from the model or, for a
 *  sampled field `sampledOf` finds in a run, from that run over the values `sampledOf` says
 *  (`sampledOf` gives null for a sampled field no run on show has, and undefined for a field of the
 *  model). A channel with no field clears its style. */
export function edgeStylesOf(
  sources: Sources,
  type: string,
  colormap: Colormap,
  sampledOf: (field: FieldRef) => Sampled | null | undefined,
): Pick<EdgeOptions, 'color' | 'dash'> {
  const { color, input } = styles(sources, type, colormap, sampledOf)
  return { color: color('edgeColor'), dash: input('edgeDash')?.field ?? null }
}

function styles(
  sources: Sources,
  type: string,
  colormap: Colormap,
  sampledOf: (field: FieldRef) => Sampled | null | undefined,
) {
  const input = (channel: Channel): { field: FieldInput; domain?: ScaleDomain } | null => {
    const ref = sources[channel]
    if (ref === undefined || ref.type !== type) return null
    const sampled = sampledOf(ref)
    if (sampled === undefined) return { field: ref.field, domain: ref.domain }
    if (sampled === null) return null
    return {
      field: { source: sampled.source, from: type, field: ref.field },
      domain: ref.domain ?? sampled.domain,
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
