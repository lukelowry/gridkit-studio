/**
 * What a case's types are and how they wire together, read from its schema alone. Topology is its
 * reference fields: a field naming a row of another type wires the two. What each view draws
 * follows from them. The network draws a type with a field of points as vertices, and a type with
 * two references to vertex types as edges between them, bent along its own list of points when it
 * has one; a position field says whether its points are longitude and latitude. The diagram draws a type that directed references name as nets, and a type holding them as
 * blocks, each such reference a port.
 */

import type { FieldDefinition, Schema } from '@latkit/model'

/** A field of one type that names a row of another. */
interface Reference {
  readonly field: string
  readonly to: string
  readonly direction?: 'in' | 'out'
}

/** An edge type a view draws: joining the two vertices its `ends` name, or, with none, a net joining
 *  the vertices that name it. */
export interface Edge {
  readonly type: string
  readonly ends?: readonly [source: string, target: string]
  /** Its list of intermediate points, when it has one. */
  readonly bends?: string
}

/** The types a view draws. */
export interface Drawn {
  readonly vertices: readonly string[]
  readonly edges: readonly Edge[]
  /** Whether its vertices are placed in longitude and latitude. */
  readonly geographic: boolean
}

/** `type`'s name: its label, or its key. */
export function typeName(schema: Schema, type: string): string {
  return schema.types[type]?.label ?? type
}

/** The fields of `type`; none for a type the schema lacks. */
function fieldsOf(schema: Schema, type: string): Readonly<Record<string, FieldDefinition>> {
  return schema.types[type]?.fields ?? {}
}

/** A name with its unit after it, the one way the page shows the two together. */
export function withUnit(name: string, unit: string | undefined): string {
  return unit ? `${name} [${unit}]` : name
}

/** A field's name with its unit: its label, or its key. */
export function fieldName(definition: FieldDefinition | undefined, field: string): string {
  return withUnit(definition?.label ?? field, definition?.unit)
}

/** Whether `definition` names a row of another type. */
export function isReference(definition: FieldDefinition | undefined): boolean {
  return typeof definition?.type === 'object' && definition.type.kind === 'reference'
}

/** The field a row of `type` is named by: `name` when it has one, else its first text field. */
export function nameFieldOf(schema: Schema, type: string): string | null {
  const texts = Object.entries(fieldsOf(schema, type)).filter(
    ([, definition]) => definition.type === 'text',
  )
  return (texts.find(([field]) => field === 'name') ?? texts[0])?.[0] ?? null
}

/** The fields of `type` that name a row of another type. */
function referencesOf(schema: Schema, type: string): Reference[] {
  return Object.entries(fieldsOf(schema, type)).flatMap(([field, { type: data, direction }]) =>
    typeof data === 'object' && data.kind === 'reference'
      ? [{ field, to: data.to, ...(direction !== undefined && { direction }) }]
      : [],
  )
}

/** Where a type stands: its first field of 2D or 3D points, one per row or a list of them. */
export interface Position {
  readonly field: string
  readonly kind: 'point' | 'route'
  /** Whether its points are longitude and latitude. */
  readonly geographic: boolean
}

/** Where `type` stands; null for a type with no points. */
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

/** What the network draws; see the module header. */
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

/** What the diagram draws; see the module header. */
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

/** Where `drawn` draws `type`: as a vertex, as an edge, or not at all. */
export function placementOf(drawn: Drawn, type: string): 'vertex' | 'edge' | null {
  if (drawn.vertices.includes(type)) return 'vertex'
  return drawn.edges.some((edge) => edge.type === type) ? 'edge' : null
}
