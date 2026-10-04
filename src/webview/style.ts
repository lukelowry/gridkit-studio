import type { Diagram } from '@latkit/diagram'
import { colormaps } from '@latkit/gpu'
import { type Data, type FieldValues, rowCount } from '@latkit/model'
import type { Network } from '@latkit/network'

import type { ViewState } from '../messages.js'
import { reader } from '../preferences.js'
import { edgeStylesOf, vertexStylesOf } from './binding-style.js'
import { BORDERS } from './borders.js'
import { diagramOptions } from './diagram-options.js'
import { labelsOf } from './labels.js'
import { networkOptions } from './network-options.js'
import { color, font, palette } from './palette.js'
import { diagramOf, nameFieldOf, networkOf } from './topology.js'
const hidden = new WeakMap<Data, Map<string, FieldValues>>()
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
export function accessibility(state: ViewState) {
  document.body.dataset.contrast = state.settings?.['accessibility.contrast'] ?? 'system'
  document.body.dataset.motion = state.settings?.['accessibility.motion'] ?? 'system'
}
export function diagramStyle(
  source: Data,
  state: ViewState,
  positions: Record<string, FieldValues> = {},
): Parameters<Diagram['set']>[0] {
  const s = reader(state.settings)
  const drawn = diagramOf(source.schema)
  const theme = palette()
  return {
    ...diagramOptions(s, theme, font()),
    ...(state.diagramEditing ? { detail: 'full' as const } : {}),
    ...(Object.keys(positions).length ? { layout: { algorithm: 'manual' as const } } : {}),
    input: {
      mode:
        state.diagramEditing && state.writable && !state.stale
          ? 'edit'
          : s.get('diagram.input.mode'),
      wheel: s.get('diagram.input.wheel'),
      keyboard: s.get('diagram.input.keyboard'),
      dragThresholdPx: s.get('diagram.input.dragThresholdPx'),
      touchDragThresholdPx: s.get('diagram.input.touchDragThresholdPx'),
    },
    vertices: Object.fromEntries(
      drawn.vertices.map((type) => {
        const field = labelsOf(source, type)
        const maxWidth = s.get('diagram.labels.maxWidth')
        return [
          type,
          {
            position: positions[type] ?? null,
            shape: s.get('diagram.shape'),
            labelPosition: s.get('diagram.labelPosition'),
            labels: field
              ? {
                  field,
                  overflow: s.get('diagram.labels.overflow'),
                  ...(maxWidth !== null ? { maxWidth } : {}),
                }
              : null,
          },
        ]
      }),
    ),
    edges: Object.fromEntries(
      drawn.edges.map(({ type }) => [
        type,
        {
          route: s.get('diagram.edges.route'),
          appearance: s.get('diagram.edges.appearance'),
          arrows: s.get('diagram.edges.arrows'),
        },
      ]),
    ),
  }
}
export function networkStyle(
  source: Data,
  state: ViewState,
  geographic: boolean,
  borders: Data | null = null,
): Parameters<Network['set']>[0] {
  const s = reader(state.settings)
  const drawn = networkOf(source.schema)
  const p = palette()
  const sampled = ({ type, field }: { type: string; field: string }) => {
    if (!source.schema.types[type]?.fields[field]?.sampled) return undefined
    return state.run &&
      state.run.fingerprint === state.summary?.fingerprint &&
      state.run.outputs.some((output) => output.from === type && output.select.includes(field))
      ? { source, domain: 'auto' as const }
      : null
  }
  const labels = (type: string, on: boolean) => {
    const field = nameFieldOf(source.schema, type)
    return on && field ? { field, maxCount: s.get('network.labels.maxCount') } : null
  }
  const cmap = colormaps[s.get('network.colormap')]
  const border = color(s.get('network.borderColor'), p.text3)
  const weight = { Coast: [1, 0.5], Country: [1, 0.5], Province: [0.75, 0.3] } as const
  return {
    ...networkOptions(s, p, font(), geographic),
    vertices: Object.fromEntries(
      drawn.vertices.map((type) => [
        type,
        {
          ...vertexStylesOf(state.bindings ?? {}, type, cmap, sampled),
          labels: labels(type, s.get('network.vertices.labels')),
        },
      ]),
    ),
    edges: Object.fromEntries(
      drawn.edges.map(({ type }) => [
        type,
        {
          ...edgeStylesOf(state.bindings ?? {}, type, cmap, sampled),
          visible: s.get('network.lines') ? null : hiddenRows(source, type),
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
                widthPx: weight[type][0] * s.get('network.borderWidthPx'),
                baseColor: border
                  ? ([border[0], border[1], border[2], border[3] * weight[type][1]] as const)
                  : null,
              },
            ]),
          )
        : null,
  }
}
