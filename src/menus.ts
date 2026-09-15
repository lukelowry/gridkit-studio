import { fieldKey, type FieldRef, type Model } from '@latkit/model'

import type { Bindings } from './bindings.js'
import type { Target } from './targets.js'

export interface Capabilities {
  network: boolean
  endpoints: boolean
  bind: boolean
  unbind: boolean
  plot?: boolean
}
export const NO_CAPABILITIES: Capabilities = {
  network: false,
  endpoints: false,
  bind: false,
  unbind: false,
}
export function classCapabilities(
  model: Model,
  classId: string,
  hasNumericFields: boolean,
  bindings: Bindings,
): Capabilities {
  const owner = model.owners.vertex === classId || model.owners.edge === classId
  return {
    network: owner || !!model.classes.find((cls) => cls.id === classId)?.anchor,
    endpoints: model.owners.edge === classId,
    bind: owner && hasNumericFields,
    unbind: bound(bindings, classId),
  }
}
export function bound(bindings: Bindings, classId: string, field?: FieldRef): boolean {
  return Object.values(bindings).some(
    (binding) =>
      binding &&
      (field ? fieldKey(binding.field) === fieldKey(field) : binding.field.classId === classId),
  )
}
// The origin affects navigation destinations only; element and field capabilities are shared.
export function menuContext(
  target: Target,
  capabilities: Capabilities,
  origin: 'table' | 'network' | 'monitor',
) {
  return {
    preventDefaultContextMenuItems: true,
    gridkitTarget: target,
    gridkitOrigin: origin,
    gridkitElement: !!target.element,
    gridkitBus: target.element?.classId === 'bus',
    gridkitField: !!target.field,
    gridkitNetwork: !!target.element && capabilities.network,
    gridkitEdge: !!target.element && capabilities.endpoints,
    gridkitBindable: capabilities.bind,
    gridkitBound: capabilities.unbind,
    gridkitRecorded: !!capabilities.plot,
    gridkitOverlapping: (target.items?.length ?? 0) > 1,
  }
}
