/** The catalog as a Schema, with each table's plan for the parser. */

import type { Bounds, DataType, FieldDefinition, Schema, TypeDefinition } from '@latkit/model'
import { failure } from '@latkit/model'

import models from './catalog.json'

export interface Catalog {
  /** As read; part of every case's version. */
  readonly text: string
  readonly bus: string
  readonly options: readonly OptionSpec[]
  /** Every table by type. */
  readonly shapes: ReadonlyMap<string, Shape>
  /** The tables records fill, by code: the bus, the signal, then each device class. */
  readonly codes: readonly Shape[]
  readonly schema: Schema
}

interface ClassSpec {
  readonly name: string
  readonly label: string
  readonly family: string
  readonly params: readonly ParamSpec[]
  readonly init: readonly { readonly id: string; readonly unit?: string }[]
  readonly ports: readonly PortSpec[]
  readonly outputs: readonly { readonly id: string; readonly unit?: string }[]
}

interface ParamSpec {
  readonly id: string
  readonly type: 'real' | 'integer' | 'flag'
  readonly unit?: string
}

interface PortSpec {
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

/** Where a field's value is in its record. */
type FieldSource =
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

interface PortPlan extends FieldPlan {
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
  readonly definition: TypeDefinition
  /** Every field by name, the identity and ports included. */
  readonly plan: ReadonlyMap<string, FieldPlan>
  /** The native identity: a device's id, a bus's number, a signal's id. */
  readonly identity: { readonly name: string; readonly type: 'text' | 'uint32' }
  /** The fields the parser fills, in column order: neither the identity, a port, nor an output. */
  readonly fields: readonly FieldPlan[]
  readonly ports: readonly PortPlan[]
  /** Each output's place in the native order, which monitor lists follow. */
  readonly outputOrder: ReadonlyMap<string, number>
}

export const SIGNAL = 'Signal'
export const CASE = 'Case'
/** The Case table's one row. */
export const CASE_ROW = 'case'

const POINT: DataType = { kind: 'vector', items: 'float64', size: 2 }
const ROUTE: DataType = { kind: 'list', items: POINT }

function catalogOf(json: unknown): Catalog {
  const text = JSON.stringify(json)
  const raw = json as {
    bus: ClassSpec
    classes: readonly ClassSpec[]
    options: readonly OptionSpec[]
  }
  const codes = [
    shapeOf(raw.bus, 'bus', raw.bus.name),
    signalShape(),
    ...raw.classes.map((spec) => shapeOf(spec, 'device', raw.bus.name)),
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

function shapeOf(spec: ClassSpec, kind: 'bus' | 'device', bus: string): Shape {
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
  return compile(
    {
      type: spec.name,
      kind,
      array: kind === 'bus' ? 'buses' : 'devices',
      identity:
        kind === 'bus' ? { name: 'number', type: 'uint32' } : { name: 'name', type: 'text' },
    },
    {
      label: spec.label,
      ...(kind === 'device' && { description: spec.family }),
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
              definition: {
                type: POINT,
                nullable: true,
                geographic: true,
                description: '[longitude, latitude]',
              },
            },
          ]
        : []),
      ...(spec.name === 'Branch'
        ? [
            {
              name: 'route',
              source: { kind: 'route' as const },
              definition: { type: ROUTE, nullable: true, geographic: true },
            },
          ]
        : []),
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

/** A table's shape, its fields sorted once into the plan, fields, ports and output order. */
function compile(
  table: Pick<Shape, 'type' | 'kind' | 'array' | 'identity'>,
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

/** GridKit's models, as Studio knows them. Pure, so bundles that never read it leave it out. */
export const catalog: Catalog = /* @__PURE__ */ catalogOf(models)
