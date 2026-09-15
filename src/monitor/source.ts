import type { FieldRef } from '@latkit/model'
import type { SourceBlock, SourceWindow } from '@latkit/monitor'
import { protocol } from '@latkit/port'

import { isField, record } from '../targets.js'
type SourceRequest = { sourceId: string; field: FieldRef } & (
  { type: 'locate'; time: number } | { type: 'read'; window: SourceWindow }
)
export const sourceProtocol = protocol<SourceRequest, number | SourceBlock>(
  'gridkit.monitor.source',
  (value: unknown): value is SourceRequest => {
    if (!record(value) || typeof value.sourceId !== 'string' || !isField(value.field)) return false
    if (value.type === 'locate')
      return typeof value.time === 'number' && Number.isFinite(value.time)
    if (value.type !== 'read' || !record(value.window)) return false
    const window = value.window
    return ['frameOffset', 'frameCount', 'elementOffset', 'elementCount'].every(
      (key) => Number.isSafeInteger(window[key]) && (window[key] as number) >= 0,
    )
  },
)
