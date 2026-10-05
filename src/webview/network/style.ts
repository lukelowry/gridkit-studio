import type { Positions } from '@latkit/diagram'
import { colormaps } from '@latkit/gpu'
import type { Data } from '@latkit/model'
import type { NetworkConfig } from '@latkit/network'

import { type FieldRef, recordedWhole } from '../../shared/bindings.js'
import type { ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { nameFieldOf, networkOf, positionOf } from '../../shared/schema.js'
import { font, palette } from '../theme.js'
import { BORDERS } from './borders.js'
import { channelsOf, type Sampled } from './channels.js'
import { networkOptions } from './options.js'

/** Province lines relative to coasts and countries, which draw as every path. */
const PROVINCE = { width: 0.75, alpha: 0.6 }

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

/** The network config for `source`, with vertices at `places` when given. Sampled fields read
 *  `samples`, colored over the `whole` run or the frame on show; labels wait for `labelled`. */
export function networkConfig(
  source: Data,
  samples: Data,
  places: Readonly<Record<string, Positions>>,
  state: ViewState,
  geographic: boolean,
  borders: Data | null,
  whole: boolean,
  labelled = true,
): Omit<NetworkConfig, 'canvas' | 'camera'> {
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
  const position = (type: string) => places[type] ?? positionOf(source.schema, type)!
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
          // A route field splits every line through points that carry no value, and so no color
          // of their ends: pass it only where the case routes lines and places are its own.
          ...(bends !== undefined && !placed && routed(source, type, bends) && { bends }),
          ...channelsOf(bindings, type, 'edge', colormap, sampled),
          // Hides edges only; borders stay drawn.
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

/** Where a bound field's values come from: undefined for the case's own data, the run for a field
 *  it recorded for every row, else null. Over the `whole` run, colors span all it recorded. */
function sampledFrom(
  source: Data,
  { run, summary }: ViewState,
  whole: boolean,
): (field: FieldRef) => Sampled | null | undefined {
  return ({ type, field }) => {
    // A binding can arrive before the stream carrying its field; it draws once the field does.
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
