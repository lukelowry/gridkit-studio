/** The catalog as a Schema, with each table's plan for the parser. A field is named by its path in
 *  the record, `params.kv` or `init.Vr`; a sampled output by GridKit's name for it, `Vm`. */

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
  /** What GridKit's cases keep under `extension`. A type's two geographic numbers place it on a
   *  map, longitude then latitude; a geographic route bends an edge. */
  readonly extension?: readonly ExtensionSpec[]
}

interface ExtensionSpec {
  readonly id: string
  readonly type?: 'real' | 'flag' | 'route'
  readonly unit?: string
  readonly geographic?: boolean
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

/** Where a field's value is in its record. A key the catalog does not know is `found` at its
 *  path; an object or array there is kept as its JSON text. */
type FieldSource =
  | {
      readonly kind:
        'identity' | 'record' | 'parameter' | 'initial' | 'extension' | 'header' | 'port' | 'output'
      readonly name: string
    }
  | { readonly kind: 'found'; readonly path: readonly string[]; readonly json: boolean }

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
  const typeOf = (spec: ParamSpec | ExtensionSpec): DataType =>
    spec.type === 'flag'
      ? 'boolean'
      : spec.type === 'integer'
        ? 'int32'
        : spec.type === 'route'
          ? ROUTE
          : 'float64'
  const field = (
    name: string,
    type: DataType,
    source: FieldSource,
    unit?: string,
    geographic?: boolean,
  ): FieldPlan => ({
    name,
    source,
    definition: {
      type,
      nullable: true,
      ...(unit !== undefined && { unit }),
      ...(geographic && { geographic }),
    },
  })
  // An output shares the namespace of the record's keys; one that takes a key's name is named by
  // where it is listed, `mon.id`.
  const keys = new Set(['number', 'id', 'name', 'class'])
  return compile(
    {
      type: spec.name,
      kind,
      array: kind === 'bus' ? 'buses' : 'devices',
      identity: kind === 'bus' ? { name: 'number', type: 'uint32' } : { name: 'id', type: 'text' },
    },
    {
      label: spec.label,
      ...(kind === 'device' && { description: spec.family }),
    },
    [
      ...(kind === 'bus' ? [field('name', 'text', { kind: 'record', name: 'name' })] : []),
      ...spec.params.map((param) =>
        field(
          `params.${param.id}`,
          typeOf(param),
          { kind: 'parameter', name: param.id },
          param.unit,
        ),
      ),
      ...spec.init.map((init) =>
        field(`init.${init.id}`, 'float64', { kind: 'initial', name: init.id }, init.unit),
      ),
      ...(spec.extension ?? []).map((extension) =>
        field(
          `extension.${extension.id}`,
          typeOf(extension),
          { kind: 'extension', name: extension.id },
          extension.unit,
          extension.geographic,
        ),
      ),
      ...spec.outputs.map((output): FieldPlan => ({
        name: keys.has(output.id) ? `mon.${output.id}` : output.id,
        source: { kind: 'output', name: output.id },
        definition: {
          label: output.id,
          type: 'float64',
          sampled: true,
          nullable: true,
          ...(output.unit !== undefined && { unit: output.unit }),
        },
      })),
      ...spec.ports.map((port): PortPlan => ({
        name: `ports.${port.name}`,
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
      ...['case_name', 'case_description', 'case_comments'].map((name): FieldPlan => ({
        name: `header.${name}`,
        source: { kind: 'header', name },
        definition: { type: 'text', nullable: true },
      })),
      ...['freq_base', 'va_base'].map((name): FieldPlan => ({
        name: `params.${name}`,
        source: { kind: 'parameter', name },
        definition: { type: 'float64', nullable: true },
      })),
    ],
  )
}

/** The shape of a device class the catalog does not know: its records keep their `id`, and every
 *  member they have is found as it is. */
export function unknownShape(type: string): Shape {
  return compile(
    { type, kind: 'device', array: 'devices', identity: { name: 'id', type: 'text' } },
    { label: type, description: 'Not in the catalog' },
    [],
  )
}

/** `shape` with `found` fields after its own. */
export function withFound(shape: Shape, found: readonly FieldPlan[]): Shape {
  const { fields: _, ...definition } = shape.definition
  return compile(
    shape,
    definition,
    [...shape.plan.values()].filter(({ source }) => source.kind !== 'identity').concat(found),
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
