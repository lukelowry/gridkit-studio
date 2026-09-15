import type { ClassData, FieldRef } from '@latkit/model'

import { identityColumn } from '../gridkit/classes.js'
export interface TableColumn {
  id: string | null
  field?: FieldRef
  label: string
  group?: string
  numeric: boolean
  identity: boolean
  width: number
  index: number
}
const QUALIFIERS: Record<string, string> = {
  init: 'initial',
  params: 'parameter',
  ports: 'port',
  top: 'top',
  extension: 'extension',
}
export function tableColumns(data: ClassData, classId: string): TableColumn[] {
  const identity = identityColumn(classId)
  const counts = new Map<string, number>()
  for (const column of data.columns) counts.set(column.label, (counts.get(column.label) ?? 0) + 1)
  const columns = data.columns.map((column, index) => {
    const block = column.id.split('.')[0]
    const qualifier = QUALIFIERS[block] ?? block
    const label = counts.get(column.label)! > 1 ? `${column.label} (${qualifier})` : column.label
    return {
      id: column.id,
      field: { classId, source: 'column' as const, id: column.id },
      label,
      group: column.group,
      numeric: column.kind === 'number',
      identity: column.id === identity,
      width:
        column.id === identity
          ? 130
          : column.kind === 'number'
            ? Math.max(100, Math.min(200, label.length * 8 + 30))
            : 170,
      index,
    }
  })
  const key = columns.find((column) => column.identity)
  return key
    ? [key, ...columns.filter((column) => column !== key)]
    : [{ id: null, label: 'id', numeric: false, identity: true, width: 130, index: -1 }, ...columns]
}

export const tableFieldId = (field: FieldRef): string =>
  field.source === 'column' ? field.id : `@signal:${field.id}`
