/** The network's config: what it draws, from the case, its places, the bindings and the run's
 *  samples, in the theme and settings. */

import type { Positions } from '@latkit/diagram'
import { colormaps } from '@latkit/gpu'
import type { Data } from '@latkit/model'
import type { NetworkConfig } from '@latkit/network'

import { type FieldRef, recordedWhole } from '../../shared/bindings.js'
import type { ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { nameFieldOf, networkOf, positionOf } from '../../shared/schema.js'
import { channelsOf, type Sampled } from '../bindings/styles.js'
import { font, palette } from '../theme.js'
import { BORDERS } from './borders.js'
import { networkOptions } from './options.js'

/** Province lines draw thinner and fainter than coasts and countries, which draw as every path. */
const PROVINCE = { width: 0.75, alpha: 0.6 }

/** What a network is told: everything but its canvas and camera. */
export type NetworkDrawn = Omit<NetworkConfig, 'canvas' | 'camera'>

/** Whether any row of `type` has a point in its route `field`. */
function routed(source: Data, type: string, field: string): boolean {
  for (const { column } of source.tables[type]?.fields[field] ?? [])
    if (
      column.kind === 'list' &&
      column.offsets[column.offset + column.length]! > column.offsets[column.offset]!
    )
      return true
  return false
}

/** The network of `source` drawn as the settings, bindings, and run on show have it. Vertices stand
 *  where `places` puts them, else where the case does. Sampled fields read `samples`, the case with
 *  the run on show: over the `whole` run their colors span all it recorded; else they follow the
 *  frame on show. Lines bend only where a case routes them, never on places laid out flat: given a
 *  route field, the renderer splits every line through points of its own, which carry no value and
 *  so no color of their ends. Labels draw only once `labelled`: a canvas holds them back until its
 *  first frame. */
export function networkConfig(
  source: Data,
  samples: Data,
  places: Readonly<Record<string, Positions>>,
  state: ViewState,
  geographic: boolean,
  borders: Data | null,
  whole: boolean,
  labelled = true,
): NetworkDrawn {
  const s = reader(state.settings)
  const drawn = networkOf(source.schema)
  const options = networkOptions(s, palette(), font(), geographic)
  const colormap = colormaps[s.get('network.colormap')]
  const sampled = sampledFrom(samples, state, whole)
  const bindings = state.bindings ?? {}
  const placed = Object.keys(places).length > 0
  const labels = (type: string, enabled: boolean) => {
    const field = nameFieldOf(source.schema, type)
    return labelled && enabled && field !== null
      ? {
          field,
          maxCount: s.get('network.labels.maxCount'),
          repeatSpacingPx: s.get('network.labels.repeatSpacingPx'),
        }
      : null
  }
  const position = (type: string) => {
    const field = positionOf(source.schema, type)!.field
    return places[type] ?? { x: field, y: { field, component: 1 } }
  }
  const [r, g, b, a] = options.pathColor!
  return {
    ...options,
    source,
    vertices: Object.fromEntries(
      drawn.vertices.map((type) => [
        type,
        {
          ...position(type),
          ...channelsOf(bindings, type, 'vertex', colormap, sampled),
          labels: labels(type, s.get('network.vertices.labels')),
        },
      ]),
    ),
    edges: Object.fromEntries(
      drawn.edges.map(({ type, ends, bends }) => [
        type,
        {
          ends,
          ...(bends !== undefined && !placed && routed(source, type, bends) && { bends }),
          ...channelsOf(bindings, type, 'edge', colormap, sampled),
          // Edges hide alone: the world's borders stay drawn.
          ...(!s.get('network.lines') && { visible: false }),
          labels: labels(type, s.get('network.edges.labels')),
        },
      ]),
    ),
    paths:
      geographic && s.get('network.borders') && borders
        ? Object.fromEntries(
            BORDERS.map((type) => [
              type,
              {
                source: borders,
                points: 'points',
                ...(type === 'Province' && {
                  color: [r, g, b, a * PROVINCE.alpha] as const,
                  widthPx: options.pathWidthPx! * PROVINCE.width,
                }),
              },
            ]),
          )
        : {},
  }
}

/** Where a bound field's values come from: undefined for the case's own data, the run for a sampled
 *  field it recorded for every row, null for one it did not. Over the `whole` run its colors span the values the
 *  field took in all of it, which the renderer measures once; else they follow the frame on show. */
function sampledFrom(
  source: Data,
  { run, summary }: ViewState,
  whole: boolean,
): (field: FieldRef) => Sampled | null | undefined {
  return ({ type, field }) => {
    // A binding is told before the stream that carries its field: it draws once that arrives.
    const held = (data: Data) => (data.tables[type]?.fields[field]?.length ?? 0) > 0
    if (source.schema.types[type]?.fields[field]?.sampled !== true)
      return held(source) ? undefined : null
    if (
      !run ||
      run.fingerprint !== summary?.fingerprint ||
      !recordedWhole(run.outputs, summary.counts[type] ?? 0, { type, field }) ||
      !held(source)
    )
      return null
    return {
      source,
      domain:
        whole && run.domain[1] > run.domain[0]
          ? { window: { kind: 'range', between: run.domain } }
          : 'auto',
    }
  }
}
