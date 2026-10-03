/** Catalog-driven schema and parser plans. */

import type { Bounds, DataType, FieldDefinition, Schema, TypeDefinition } from '@latkit/model'
import { failure } from '@latkit/model'

export interface Catalog {
  /** As read: workers parse it again, and it is part of every case's version. */
  readonly text: string
  readonly bus: string
  readonly options: readonly OptionSpec[]
  /** Every table by type. */
  readonly shapes: ReadonlyMap<string, Shape>
  /** The tables records fill, by code: the bus, the signal, then each device class. */
  readonly codes: readonly Shape[]
  readonly schema: Schema
}

export interface ClassSpec {
  readonly name: string
  readonly label: string
  readonly family: string
  readonly params: readonly ParamSpec[]
  readonly init: readonly { readonly id: string; readonly unit?: string }[]
  readonly ports: readonly PortSpec[]
  readonly outputs: readonly { readonly id: string; readonly unit?: string }[]
}

export interface ParamSpec {
  readonly id: string
  readonly type: 'real' | 'integer' | 'flag'
  readonly unit?: string
}

export interface PortSpec {
  readonly required?: boolean
  readonly name: string
  readonly kind: 'bus' | 'signal'
  readonly direction: 'in' | 'out' | 'both'
}

export interface OptionSpec {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly type: 'real' | 'integer' | 'choice'
  readonly unit?: string
  readonly bounds?: Bounds
  readonly default?: number | string
  readonly optional?: boolean
  readonly choices?: readonly { readonly id: string; readonly label: string }[]
}

export type ArrayName = 'buses' | 'signals' | 'devices'

export type FieldSource =
  | {
      readonly kind: 'identity' | 'record' | 'parameter' | 'initial' | 'header' | 'port' | 'output'
      readonly name: string
    }
  | { readonly kind: 'position' | 'route' }

export interface FieldPlan {
  readonly required?: boolean
  readonly name: string
  readonly definition: FieldDefinition
  readonly source: FieldSource
}

export interface PortPlan extends FieldPlan {
  readonly definition: FieldDefinition & {
    readonly type: { readonly kind: 'reference'; readonly to: string }
  }
  readonly source: { readonly kind: 'port'; readonly name: string }
}

export interface Shape {
  readonly type: string
  readonly kind: 'bus' | 'signal' | 'device' | 'case'
  /** The array its records are in; null for the Case table. */
  readonly array: ArrayName | null
  /** Its place in `Catalog.codes`; -1 for the Case table. */
  readonly code: number
  readonly definition: TypeDefinition
  /** All public fields, compiled once; consumers do not interpret native naming conventions. */
  readonly plan: ReadonlyMap<string, FieldPlan>
  /** The native identity: a device's id, a bus's number, a signal's id. */
  readonly identity: { readonly name: string; readonly type: 'text' | 'uint32' }
  readonly fields: readonly FieldPlan[]
  readonly ports: readonly PortPlan[]
  /** Native output order, used when writing monitor lists. */
  readonly outputOrder: ReadonlyMap<string, number>
}

export const SIGNAL = 'Signal'
export const CASE = 'Case'
/** The Case table's one row. */
export const CASE_ROW = 'case'

const POINT: DataType = { kind: 'vector', items: 'float64', size: 2 }
const ROUTE: DataType = { kind: 'list', items: POINT }

export function catalogOf(text: string): Catalog {
  const raw = JSON.parse(text) as {
    bus: ClassSpec
    classes: readonly ClassSpec[]
    options: readonly OptionSpec[]
  }
  const codes = [
    shapeOf(raw.bus, 'bus', 0, raw.bus.name),
    signalShape(),
    ...raw.classes.map((spec, i) => shapeOf(spec, 'device', i + 2, raw.bus.name)),
  ]
  const shapes = new Map<string, Shape>()
  for (const shape of [...codes, caseShape()]) {
    if (shapes.has(shape.type))
      throw failure('invalid-input', `The catalog declares ${shape.type} twice.`)
    shapes.set(shape.type, shape)
  }
  const types: Record<string, TypeDefinition> = Object.create(null)
  for (const [type, shape] of shapes) types[type] = shape.definition
  const schema: Schema = {
    axis: { name: 'time', unit: 's' },
    types,
  }
  return { text, bus: raw.bus.name, options: raw.options, shapes, codes, schema }
}

function shapeOf(spec: ClassSpec, kind: 'bus' | 'device', code: number, bus: string): Shape {
  const parameters = new Set(spec.params.map((param) => param.id))
  for (const port of spec.ports)
    if (parameters.has(port.name))
      throw failure('invalid-input', `${spec.name}.${port.name} is both a parameter and a port.`)
  const typeOf = (param: ParamSpec): DataType =>
    param.type === 'flag' ? 'boolean' : param.type === 'integer' ? 'int32' : 'float64'
  const field = (name: string, type: DataType, source: FieldSource, unit?: string): FieldPlan => ({
    name,
    source,
    definition: { type, nullable: true, ...(unit !== undefined && { unit }) },
  })
  const spatial = kind === 'bus' ? 'position' : spec.name === 'Branch' ? 'route' : undefined
  return compile(
    {
      type: spec.name,
      kind,
      array: kind === 'bus' ? 'buses' : 'devices',
      code,
      identity:
        kind === 'bus' ? { name: 'number', type: 'uint32' } : { name: 'name', type: 'text' },
    },
    {
      label: spec.label,
      ...(kind === 'device' && { description: spec.family }),
      ...(spatial !== undefined && { spatial: { field: spatial, system: 'geographic' } }),
    },
    [
      ...(kind === 'bus' ? [field('name', 'text', { kind: 'record', name: 'name' })] : []),
      ...spec.params.map((param) =>
        field(param.id, typeOf(param), { kind: 'parameter', name: param.id }, param.unit),
      ),
      ...spec.init.map((init) =>
        field(`init.${init.id}`, 'float64', { kind: 'initial', name: init.id }, init.unit),
      ),
      ...(kind === 'bus'
        ? [
            {
              name: 'position',
              source: { kind: 'position' as const },
              definition: { type: POINT, nullable: true, description: '[longitude, latitude]' },
            },
          ]
        : []),
      ...(spec.name === 'Branch' ? [field('route', ROUTE, { kind: 'route' })] : []),
      ...spec.outputs.map((output): FieldPlan => ({
        name: output.id,
        source: { kind: 'output', name: output.id },
        definition: {
          type: 'float64',
          sampled: true,
          nullable: true,
          ...(output.unit !== undefined && { unit: output.unit }),
        },
      })),
      ...spec.ports.map((port): PortPlan => ({
        name: port.kind === 'signal' ? `ports.${port.name}` : port.name,
        source: { kind: 'port', name: port.name },
        required: port.required === true,
        definition: {
          label: port.name,
          type: { kind: 'reference', to: port.kind === 'bus' ? bus : SIGNAL },
          nullable: true,
          ...(port.direction !== 'both' && { direction: port.direction }),
        },
      })),
    ],
  )
}

function signalShape(): Shape {
  return compile(
    {
      type: SIGNAL,
      kind: 'signal',
      array: 'signals',
      code: 1,
      identity: { name: 'signal_id', type: 'uint32' },
    },
    { label: SIGNAL },
    [
      {
        name: 'name',
        source: { kind: 'record', name: 'name' },
        definition: { type: 'text', nullable: true },
      },
    ],
  )
}

function caseShape(): Shape {
  return compile(
    {
      type: CASE,
      kind: 'case',
      array: null,
      code: -1,
      identity: { name: 'id', type: 'text' },
    },
    { label: CASE },
    [
      ...['name', 'description', 'comments'].map((name): FieldPlan => ({
        name,
        source: { kind: 'header', name: `case_${name}` },
        definition: { type: 'text', nullable: true },
      })),
      ...['freq_base', 'va_base'].map((name): FieldPlan => ({
        name,
        source: { kind: 'parameter', name },
        definition: { type: 'float64', nullable: true },
      })),
    ],
  )
}

/** Classify the plan once. The parser works with indexed arrays, never this map per row. */
function compile(
  table: Pick<Shape, 'type' | 'kind' | 'array' | 'code' | 'identity'>,
  definition: Omit<TypeDefinition, 'fields'>,
  entries: readonly FieldPlan[],
): Shape {
  const plan = new Map<string, FieldPlan>()
  const definitions: Record<string, FieldDefinition> = Object.create(null)
  const fields: FieldPlan[] = []
  const ports: PortPlan[] = []
  const outputOrder = new Map<string, number>()
  const identity: FieldPlan = {
    name: table.identity.name,
    source: { kind: 'identity', name: table.kind === 'device' ? 'id' : table.identity.name },
    definition: { type: table.identity.type },
  }
  for (const field of [...(table.kind === 'case' ? [] : [identity]), ...entries]) {
    if (plan.has(field.name))
      throw failure('invalid-input', `${table.type}.${field.name} is declared twice.`)
    plan.set(field.name, field)
    definitions[field.name] = field.definition
    switch (field.source.kind) {
      case 'identity':
        break
      case 'output':
        outputOrder.set(field.name, outputOrder.size)
        break
      case 'port':
        ports.push(field as PortPlan)
        break
      default:
        fields.push(field)
    }
  }
  return {
    ...table,
    plan,
    fields,
    ports,
    outputOrder,
    definition: { ...definition, fields: definitions },
  }
}
