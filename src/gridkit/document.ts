import type { Fields, Id, Reference, Values } from 'latkit'

import type { CaseDefinition } from '../shared/document.js'

/** A lazy source projection. Native datasets never own source spans or editing metadata. */
export interface ProjectedTable {
  readonly ids: readonly Id[]
  read(field: string, offset: number, count: number): Values | Reference
}

export interface ProjectedDocument {
  readonly key: string
  readonly definition: CaseDefinition
  readonly tables: ReadonlyMap<string, ProjectedTable>
}

export interface ChangedRows {
  readonly table: string
  readonly ids: readonly Id[]
  readonly fields: Fields
}
