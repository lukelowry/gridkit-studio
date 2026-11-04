/** GridKit's document semantics. These are independent of a rendered dataset. */
import type { Id } from 'latkit'

export interface Entity {
  readonly table: string
  readonly id: Id
}

export interface Element extends Entity {
  readonly field?: string
}

type FieldKind = 'number' | 'boolean' | 'text' | 'reference' | 'path' | 'json' | 'sampled'

export interface FieldDefinition {
  readonly name: string
  readonly kind: FieldKind
  readonly label: string
  readonly unit?: string
  readonly required?: boolean
  readonly integer?: boolean
  readonly target?: string
  readonly direction?: 'in' | 'out'
}

export interface TableDefinition {
  readonly name: string
  readonly label: string
  readonly identity: string
  readonly labelField: string
  readonly fields: readonly FieldDefinition[]
}

interface VertexDefinition {
  readonly table: string
  readonly label?: string
  readonly position: [string, string]
}

interface EdgeDefinition {
  readonly table: string
  readonly ends?: [string, string]
  readonly bends?: string
}

export interface Drawing {
  readonly geographic: boolean
  readonly vertices: readonly VertexDefinition[]
  readonly edges: readonly EdgeDefinition[]
}

export interface CaseDefinition {
  readonly tables: readonly TableDefinition[]
  readonly drawing: Drawing
}

export const LABEL = '@studio.label'
export const NETWORK_POSITION: [string, string] = ['@studio.network.x', '@studio.network.y']

export function entityKey(entity: Entity): string {
  return JSON.stringify([entity.table, entity.id])
}

export function entityLabel(entity: Entity): string {
  return `${entity.table} ${String(entity.id)}`
}

function withUnit(name: string, unit: string | undefined): string {
  return unit ? `${name} [${unit}]` : name
}

export function tableDefinition(
  document: CaseDefinition,
  name: string,
): TableDefinition | undefined {
  return document.tables.find((table) => table.name === name)
}

export function fieldDefinition(
  document: CaseDefinition,
  table: string,
  field: string,
): FieldDefinition | undefined {
  return tableDefinition(document, table)?.fields.find((item) => item.name === field)
}

/** A field's name past the object it is in: `kv` of `params.kv`. */
export const leaf = (field: string): string => field.slice(field.indexOf('.') + 1)

export function fieldLabel(field: FieldDefinition): string {
  const unit = field.unit?.toLowerCase() === leaf(field.name).toLowerCase() ? undefined : field.unit
  return withUnit(field.label, unit)
}

export function tableLabel(document: CaseDefinition, name: string): string {
  return tableDefinition(document, name)?.label ?? name
}

export function networkRole(document: CaseDefinition, name: string): 'vertex' | 'edge' | null {
  if (document.drawing.vertices.some((item) => item.table === name)) return 'vertex'
  if (document.drawing.edges.some((item) => item.table === name)) return 'edge'
  return null
}

export function referenceFields(
  document: CaseDefinition,
  name: string,
): readonly FieldDefinition[] {
  return tableDefinition(document, name)?.fields.filter((field) => field.kind === 'reference') ?? []
}

export function isEntity(value: unknown): value is Entity {
  if (!value || typeof value !== 'object') return false
  const entity = value as Partial<Entity>
  return (
    typeof entity.table === 'string' &&
    (typeof entity.id === 'string' ||
      (typeof entity.id === 'number' && Number.isSafeInteger(entity.id) && entity.id >= 0))
  )
}
