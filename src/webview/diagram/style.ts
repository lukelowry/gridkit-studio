/** The diagram's config: what it draws, from the case and where its blocks were arranged, in the
 *  theme, settings, and editing mode. */

import type { DiagramConfig, Positions } from '@latkit/diagram'
import type { Data } from '@latkit/model'

import type { ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { diagramOf } from '../../shared/schema.js'
import { font, palette } from '../theme.js'
import { labelsOf } from './labels.js'
import { diagramOptions } from './options.js'

/** What a diagram is told: everything but its canvas and camera. */
export type DiagramDrawn = Omit<DiagramConfig, 'canvas' | 'camera'>

/** The diagram of `source`. Blocks the case arranged stand where `places` says; without any, the
 *  diagram lays them out. */
export function diagramConfig(
  source: Data,
  state: ViewState,
  places: Readonly<Record<string, Positions>> = {},
): DiagramDrawn {
  const s = reader(state.settings)
  const drawn = diagramOf(source.schema)
  const editing = state.diagramEditing === true
  const options = diagramOptions(s, palette(), font())
  const maxWidth = s.get('diagram.labels.maxWidth')
  return {
    ...options,
    ...(editing && { detail: 'full' as const }),
    ...(Object.keys(places).length > 0 && {
      layout: { ...options.layout, algorithm: 'manual' as const },
    }),
    input: {
      ...options.input,
      mode: editing && state.writable && !state.stale ? 'edit' : options.input.mode,
    },
    source,
    vertices: Object.fromEntries(
      drawn.vertices.map((type) => {
        const field = labelsOf(source, type)
        return [
          type,
          {
            ...places[type],
            shape: s.get('diagram.shape'),
            labelPosition: s.get('diagram.labelPosition'),
            labels: field
              ? {
                  field,
                  overflow: s.get('diagram.labels.overflow'),
                  ...(maxWidth !== null && { maxWidth }),
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
