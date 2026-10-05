/** Apply theme, bindings, and run samples to the network renderer. */

import { colormaps } from '@latkit/gpu'
import { type Data, type FieldValues, rowCount } from '@latkit/model'
import type { Network } from '@latkit/network'

import { type FieldRef, recordedWhole } from '../../shared/bindings.js'
import type { ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { nameFieldOf, networkOf } from '../../shared/schema.js'
import { edgeStylesOf, type Sampled, vertexStylesOf } from '../bindings/styles.js'
import { color, font, palette } from '../theme.js'
import { type Border, BORDERS } from './borders.js'
import { networkOptions } from './options.js'

/** How each kind of border draws: its width, and how strongly it shows over the ground. */
const BORDER_STYLES: Readonly<
  Record<Border, { readonly widthPx: number; readonly alpha: number }>
> = {
  Coast: { widthPx: 1, alpha: 0.5 },
  Country: { widthPx: 1, alpha: 0.5 },
  Province: { widthPx: 0.75, alpha: 0.3 },
}

const hidden = new WeakMap<Data, Map<string, FieldValues>>()

/** Every row of `type` in `source` hidden, as a `visible` field reads it: made once for each source
 *  and type, so the renderer uploads it once. */
function hiddenRows(source: Data, type: string): FieldValues {
  let types = hidden.get(source)
  if (!types) hidden.set(source, (types = new Map()))
  let value = types.get(type)
  if (!value) {
    const { index, rows } = source.tables[type]!
    const length = rowCount(rows)
    value = {
      index,
      rows,
      values: { kind: 'boolean', offset: 0, length, values: new Uint8Array(Math.ceil(length / 8)) },
    }
    types.set(type, value)
  }
  return value
}

/** One style transaction: what the network of `source` is told, and what an export captures
 *  unchanged. Sampled fields read `samples`, the case with the run on show: over the `whole` run
 *  their colors span all it recorded; else they follow the frame on show. Labels draw only once
 *  `labelled`: a canvas holds them back until its first frame. */
export function networkStyle(
  source: Data,
  samples: Data,
  state: ViewState,
  geographic: boolean,
  borders: Data | null,
  whole: boolean,
  labelled = true,
): Parameters<Network['set']>[0] {
  const s = reader(state.settings)
  const drawn = networkOf(source.schema)
  const p = palette()
  const colormap = colormaps[s.get('network.colormap')]
  const sampled = sampledFrom(samples, state, whole)
  const borderColor = color(s.get('network.borderColor'), p.text3)
  const labels = (type: string, enabled: boolean) => {
    const field = nameFieldOf(source.schema, type)
    return labelled && enabled && field !== null
      ? { field, maxCount: s.get('network.labels.maxCount') }
      : null
  }
  return {
    ...networkOptions(s, p, font(), geographic),
    vertices: Object.fromEntries(
      drawn.vertices.map((type) => [
        type,
        {
          ...vertexStylesOf(state.bindings ?? {}, type, colormap, sampled),
          labels: labels(type, s.get('network.vertices.labels')),
        },
      ]),
    ),
    edges: Object.fromEntries(
      drawn.edges.map(({ type }) => [
        type,
        {
          ...edgeStylesOf(state.bindings ?? {}, type, colormap, sampled),
          visible: s.get('network.lines') ? null : hiddenRows(source, type),
          labels: labels(type, s.get('network.edges.labels')),
        },
      ]),
    ),
    paths:
      geographic && s.get('network.borders') && borders
        ? Object.fromEntries(
            BORDERS.map((type) => {
              const { widthPx, alpha } = BORDER_STYLES[type]
              return [
                type,
                {
                  source: borders,
                  points: 'points',
                  widthPx: widthPx * s.get('network.borderWidthPx'),
                  baseColor:
                    borderColor === null
                      ? null
                      : ([
                          borderColor[0],
                          borderColor[1],
                          borderColor[2],
                          borderColor[3] * alpha,
                        ] as const),
                },
              ]
            }),
          )
        : null,
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
