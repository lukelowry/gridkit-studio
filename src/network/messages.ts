import type { Item, Topology } from '@latkit/model'
import { type Projection, PROJECTIONS } from '@latkit/network'

import type { DisplayChannel } from '../bindings.js'
import type { Capabilities } from '../menus.js'
import type { Selection } from '../targets.js'
import { type CaseTarget, index, isCaseTarget, record } from '../targets.js'
import { type DisplayOptions, validOptions } from './options.js'
export type ToWebview =
  | ({ type: 'scene'; topology: Topology; owners: { vertex?: string; edge?: string } } & CaseTarget)
  | ({ type: 'target' } & CaseTarget)
  | ({ type: 'pending' } & CaseTarget)
  | ({ type: 'invalid'; message: string } & CaseTarget)
  | ({
      type: 'selection'
      navigate?: boolean
      item: Item | null
      selection: Selection | null
      capabilities: Capabilities
    } & CaseTarget)
  | ({
      type: 'context'
      capabilities: Partial<Record<'vertex' | 'edge', Capabilities>>
    } & CaseTarget)
  | ({
      type: 'channels'
      colormap?: string
      values: Partial<Record<DisplayChannel, Float32Array>>
    } & CaseTarget)
  | ({ type: 'reveal'; item: Item; neighbors: boolean } & CaseTarget)
  | { type: 'settings'; branchColorsFromBuses: boolean }
  | { type: 'fit' }
  | { type: 'orbit' }
  | { type: 'options'; options: DisplayOptions }
  | { type: 'projection'; projection: Projection }
export type FromWebview =
  | { type: 'ready' }
  | { type: 'source' }
  | { type: 'focus' }
  | ({ type: 'select'; item: Item | null } & CaseTarget)
  | ({
      type: 'view'
      projection: Projection
      projections: Projection[]
      options: DisplayOptions
    } & CaseTarget)
  | ({ type: 'error'; message: string } & CaseTarget)
export const isProjection = (value: unknown): value is Projection =>
  PROJECTIONS.includes(value as Projection)
export function isRequest(value: unknown): value is FromWebview {
  if (!record(value)) return false
  if (value.type === 'ready' || value.type === 'source' || value.type === 'focus') return true
  if (!isCaseTarget(value)) return false
  switch (value.type) {
    case 'select':
      return (
        value.item === null ||
        (record(value.item) &&
          index(value.item.index) &&
          (value.item.kind === 'vertex' || value.item.kind === 'edge'))
      )
    case 'view':
      return (
        isProjection(value.projection) &&
        Array.isArray(value.projections) &&
        value.projections.length <= PROJECTIONS.length &&
        value.projections.every(isProjection) &&
        validOptions(value.options)
      )
    case 'error':
      return typeof value.message === 'string' && value.message.length <= 2000
    default:
      return false
  }
}
