/** Apply theme, settings, saved arrangement, and editing mode to the diagram renderer. */

import type { Diagram } from '@latkit/diagram'
import type { Data, FieldValues } from '@latkit/model'

import type { ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { diagramOf } from '../../shared/schema.js'
import { font, palette } from '../theme.js'
import { labelsOf } from './labels.js'
import { diagramOptions } from './options.js'

/** One style transaction: what the diagram is told, and what an export captures unchanged. Blocks
 *  the case arranged stand where `places` says; without any, the diagram lays them out. */
export function diagramStyle(
  source: Data,
  state: ViewState,
  places: Readonly<Record<string, FieldValues>> = {},
): Parameters<Diagram['set']>[0] {
  const s = reader(state.settings)
  const drawn = diagramOf(source.schema)
  const editing = state.diagramEditing === true
  return {
    ...diagramOptions(s, palette(), font()),
    ...(editing && { detail: 'full' as const }),
    ...(Object.keys(places).length > 0 && { layout: { algorithm: 'manual' as const } }),
    input: {
      mode: editing && state.writable && !state.stale ? 'edit' : s.get('diagram.input.mode'),
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
            position: places[type] ?? null,
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
