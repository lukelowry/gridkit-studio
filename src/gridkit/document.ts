import type { Id, Reference, Values } from 'latkit'

import type { CaseDefinition } from '../shared/document.js'

/** A case table whose columns are read on demand. */
export interface CaseTable {
  readonly ids: readonly Id[]
  read(field: string, offset: number, count: number): Values | Reference
}

export interface CaseColumns {
  readonly key: string
  readonly definition: CaseDefinition
  readonly tables: ReadonlyMap<string, CaseTable>
}
