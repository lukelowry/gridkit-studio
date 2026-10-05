/** A case's topology, read from its schema alone: what the network and the diagram draw. */

import type { FieldDefinition, Schema } from '@latkit/model'

/** A field of one type that names a row of another. */
interface Reference {
  readonly field: string
  readonly to: string
  readonly direction?: 'in' | 'out'
}

/** A type drawn as edges: each joins the vertices its two `ends` fields name, or, without `ends`,
 *  is a net joining every vertex that names it. */
interface Edge {
  readonly type: string
  readonly ends?: readonly [source: string, target: string]
  /** The route field of intermediate points. */
  readonly bends?: string
}

/** The types a view draws. */
export interface Drawn {
  readonly vertices: readonly string[]
  readonly edges: readonly Edge[]
  /** Whether vertices are placed by longitude and latitude. */
  readonly geographic: boolean
}

/** A type's first field of 2D or 3D points: one per row, or a route of them. */
interface Position {
  readonly field: string
  readonly kind: 'point' | 'route'
  /** Whether the points are longitude and latitude. */
  readonly geographic: boolean
}

/** The type an element id names: `Bus` of `Bus/7`. */
export function elementType(id: string): string {
  return id.split('/', 1)[0]!
}

/** `type`'s label, or its key. */
export function typeName(schema: Schema, type: string): string {
  return schema.types[type]?.label ?? type
}

function fieldsOf(schema: Schema, type: string): Readonly<Record<string, FieldDefinition>> {
  return schema.types[type]?.fields ?? {}
}

/** The one format for a name with a unit. */
function withUnit(name: string, unit: string | undefined): string {
  return unit ? `${name} [${unit}]` : name
}

/** A field's label, or its key, with its unit. */
export function fieldName(definition: FieldDefinition | undefined, field: string): string {
  return withUnit(definition?.label ?? field, definition?.unit)
}

export function isReference(definition: FieldDefinition | undefined): boolean {
  return typeof definition?.type === 'object' && definition.type.kind === 'reference'
}

/** The field naming a row of `type`: `name` when it has one, else its first text field. */
export function nameFieldOf(schema: Schema, type: string): string | null {
  const texts = Object.entries(fieldsOf(schema, type)).filter(
    ([, definition]) => definition.type === 'text',
  )
  return (texts.find(([field]) => field === 'name') ?? texts[0])?.[0] ?? null
}

function referencesOf(schema: Schema, type: string): Reference[] {
  return Object.entries(fieldsOf(schema, type)).flatMap(([field, { type: data, direction }]) =>
    typeof data === 'object' && data.kind === 'reference'
      ? [{ field, to: data.to, ...(direction !== undefined && { direction }) }]
      : [],
  )
}

export function positionOf(schema: Schema, type: string): Position | null {
  for (const [field, definition] of Object.entries(fieldsOf(schema, type))) {
    const data = definition.type
    const point = typeof data === 'object' && data.kind === 'list' ? data.items : data
    if (typeof point === 'object' && point.kind === 'vector' && point.size >= 2)
      return {
        field,
        kind: point === data ? 'point' : 'route',
        geographic: definition.geographic === true,
      }
  }
  return null
}

/** Vertices are types with a point field; edges are other types with exactly two references to
 *  vertex types, bent along their route if they have one. */
export function networkOf(schema: Schema): Drawn {
  const vertices = Object.keys(schema.types).filter(
    (type) => positionOf(schema, type)?.kind === 'point',
  )
  const edges = Object.keys(schema.types).flatMap((type): Edge[] => {
    if (vertices.includes(type)) return []
    const ends = referencesOf(schema, type).filter(({ to }) => vertices.includes(to))
    if (ends.length !== 2) return []
    const route = positionOf(schema, type)
    const bends = route?.kind === 'route' ? route.field : undefined
    return [{ type, ends: [ends[0]!.field, ends[1]!.field], ...(bends !== undefined && { bends }) }]
  })
  const geographic =
    vertices.length > 0 && vertices.every((type) => positionOf(schema, type)!.geographic)
  return { vertices, edges, geographic }
}

/** Nets are types that directed references name; blocks are the other types holding those
 *  references, each one a port. */
export function diagramOf(schema: Schema): Drawn {
  const directed = Object.keys(schema.types).flatMap((type) =>
    referencesOf(schema, type)
      .filter(({ direction }) => direction !== undefined)
      .map(({ to }) => ({ type, to })),
  )
  const nets = [...new Set(directed.map(({ to }) => to))]
  const vertices = [...new Set(directed.map(({ type }) => type))].filter(
    (type) => !nets.includes(type),
  )
  return { vertices, edges: nets.map((type) => ({ type })), geographic: false }
}

export function placementOf(drawn: Drawn, type: string): 'vertex' | 'edge' | null {
  if (drawn.vertices.includes(type)) return 'vertex'
  return drawn.edges.some((edge) => edge.type === type) ? 'edge' : null
}
