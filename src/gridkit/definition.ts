/** GridKit catalog semantics and source decoding rules, independent of native dataset storage. */
import { createHash } from 'node:crypto'

import type { Port } from 'latkit'

import {
  type CaseDefinition,
  DIAGRAM_POSITION,
  type FieldDefinition,
  LABEL,
  NETWORK_POSITION,
  type TableDefinition,
} from '../shared/document.js'
import { problem } from '../shared/errors.js'
import models from './catalog.json'
import type { DecodeKind } from './columns.js'

export type ArrayName = 'buses' | 'signals' | 'devices'
export const SIGNAL = 'Signal'
export const CASE = 'Case'
export const BUS_CODE = 0
export const SIGNAL_CODE = 1
export const DEVICE_CODES = 2
export const CASE_ROW = 'case'
type FieldSource =
  | {
      readonly kind:
        'identity' | 'record' | 'parameter' | 'initial' | 'extension' | 'header' | 'port' | 'output'
      readonly name: string
    }
  | { readonly kind: 'found'; readonly path: readonly string[]; readonly json: boolean }
export interface FieldPlan {
  readonly name: string
  readonly definition: FieldDefinition
  readonly decode: DecodeKind
  readonly source: FieldSource
  readonly required?: boolean
  readonly choices?: readonly string[]
  readonly geographic?: boolean
}
export interface PortPlan extends FieldPlan {
  readonly definition: FieldDefinition & { readonly kind: 'reference'; readonly target: string }
  readonly source: { readonly kind: 'port'; readonly name: string }
}
export interface Shape {
  readonly type: string
  readonly kind: 'bus' | 'signal' | 'device' | 'case'
  readonly array: ArrayName | null
  readonly identity: { readonly name: string; readonly type: 'text' | 'unsigned' }
  readonly definition: TableDefinition
  readonly plan: ReadonlyMap<string, FieldPlan>
  readonly fields: readonly FieldPlan[]
  readonly ports: readonly PortPlan[]
  readonly outputOrder: ReadonlyMap<string, number>
}
export interface Catalog {
  readonly text: string
  readonly version: string
  readonly bus: string
  readonly shapes: ReadonlyMap<string, Shape>
  readonly codes: readonly Shape[]
  readonly definition: CaseDefinition
}
interface ClassSpec {
  readonly name: string
  readonly classes?: readonly string[]
  readonly label: string
  readonly params: readonly {
    readonly id: string
    readonly type: 'real' | 'integer' | 'flag'
    readonly unit?: string
  }[]
  readonly init: readonly { readonly id: string; readonly unit?: string }[]
  readonly ports: readonly {
    readonly required?: boolean
    readonly name: string
    readonly kind: 'bus' | 'signal'
    readonly direction: 'in' | 'out' | 'both'
  }[]
  readonly outputs: readonly { readonly id: string; readonly unit?: string }[]
  readonly extension?: readonly {
    readonly id: string
    readonly type?: 'real' | 'flag' | 'route'
    readonly unit?: string
    readonly geographic?: boolean
  }[]
}
function field(name: string, decode: DecodeKind, source: FieldSource, unit?: string): FieldPlan {
  const kind = decode === 'integer' || decode === 'unsigned' ? 'number' : decode
  return {
    name,
    decode,
    source,
    definition: {
      name,
      kind,
      label: name,
      ...(unit !== undefined && { unit }),
      ...((decode === 'integer' || decode === 'unsigned') && { integer: true }),
    },
  }
}
export function catalogOf(json: unknown): Catalog {
  const raw = json as { bus?: ClassSpec; classes?: ClassSpec[] } | null
  if (typeof raw?.bus?.name !== 'string' || !Array.isArray(raw.classes))
    throw problem('invalid-input', 'A catalog has a bus and a list of classes.')
  const text = JSON.stringify(json)
  const codes = [
    shapeOf(raw.bus, 'bus', raw.bus.name),
    signalShape(),
    ...raw.classes.map((spec) => shapeOf(spec, 'device', raw.bus!.name)),
  ]
  const shapes = new Map<string, Shape>()
  for (const shape of [...codes, caseShape()]) {
    if (shapes.has(shape.type))
      throw problem('invalid-input', `The catalog declares ${shape.type} twice.`)
    shapes.set(shape.type, shape)
  }
  return {
    text,
    version: createHash('sha256').update(text).digest('hex').slice(0, 32),
    bus: raw.bus.name,
    codes,
    shapes,
    definition: definitionsOf([...shapes.values()]),
  }
}
function shapeOf(spec: ClassSpec, kind: 'bus' | 'device', bus: string): Shape {
  const parameters = new Set(spec.params.map((param) => param.id))
  for (const port of spec.ports)
    if (parameters.has(port.name))
      throw problem('invalid-input', `${spec.name}.${port.name} is both a parameter and a port.`)
  const keys = new Set(['number', 'id', 'name', 'class'])
  return compile(
    {
      type: spec.name,
      kind,
      array: kind === 'bus' ? 'buses' : 'devices',
      identity:
        kind === 'bus' ? { name: 'number', type: 'unsigned' } : { name: 'id', type: 'text' },
    },
    spec.label,
    [
      ...(kind === 'bus'
        ? [
            field('name', 'text', { kind: 'record', name: 'name' }),
            {
              ...field('class', 'text', { kind: 'record', name: 'class' }),
              choices: spec.classes ?? [spec.name],
            },
          ]
        : []),
      ...spec.params.map((param) =>
        field(
          `params.${param.id}`,
          param.type === 'flag' ? 'boolean' : param.type === 'integer' ? 'integer' : 'number',
          { kind: 'parameter', name: param.id },
          param.unit,
        ),
      ),
      ...spec.init.map((init) =>
        field(`init.${init.id}`, 'number', { kind: 'initial', name: init.id }, init.unit),
      ),
      ...(spec.extension ?? []).map((extension) => ({
        ...field(
          `extension.${extension.id}`,
          extension.type === 'flag' ? 'boolean' : extension.type === 'route' ? 'path' : 'number',
          { kind: 'extension', name: extension.id },
          extension.unit,
        ),
        geographic: extension.geographic,
      })),
      ...spec.outputs.map((output): FieldPlan => {
        const name = keys.has(output.id) ? `mon.${output.id}` : output.id
        return {
          name,
          decode: 'number',
          source: { kind: 'output', name: output.id },
          definition: {
            name,
            label: output.id,
            kind: 'sampled',
            ...(output.unit !== undefined && { unit: output.unit }),
          },
        }
      }),
      ...spec.ports.map((port): PortPlan => {
        const name = `ports.${port.name}`
        return {
          name,
          decode: 'unsigned',
          source: { kind: 'port', name: port.name },
          required: port.required === true,
          definition: {
            name,
            label: port.name,
            kind: 'reference',
            target: port.kind === 'bus' ? bus : SIGNAL,
            required: port.required === true,
            ...(port.direction !== 'both' && { direction: port.direction }),
          },
        }
      }),
    ],
  )
}
function signalShape(): Shape {
  return compile(
    {
      type: SIGNAL,
      kind: 'signal',
      array: 'signals',
      identity: { name: 'signal_id', type: 'unsigned' },
    },
    SIGNAL,
    [field('name', 'text', { kind: 'record', name: 'name' })],
  )
}
function caseShape(): Shape {
  return compile(
    { type: CASE, kind: 'case', array: null, identity: { name: 'id', type: 'text' } },
    CASE,
    [
      ...['case_name', 'case_description', 'case_comments'].map((name) =>
        field(`header.${name}`, 'text', { kind: 'header', name }),
      ),
      ...['freq_base', 'va_base'].map((name) =>
        field(`params.${name}`, 'number', { kind: 'parameter', name }),
      ),
    ],
  )
}
export function unknownShape(type: string): Shape {
  return compile(
    { type, kind: 'device', array: 'devices', identity: { name: 'id', type: 'text' } },
    type,
    [],
  )
}
export function withFound(shape: Shape, found: readonly FieldPlan[]): Shape {
  const taken = new Set(found.map(({ name }) => name))
  return compile(
    shape,
    shape.definition.label,
    [...shape.plan.values()]
      .filter(({ source }) => source.kind !== 'identity')
      .map((plan) =>
        plan.source.kind === 'output' && taken.has(plan.name)
          ? {
              ...plan,
              name: `mon.${plan.name}`,
              definition: { ...plan.definition, name: `mon.${plan.name}` },
            }
          : plan,
      )
      .concat(found),
  )
}
function compile(
  table: Pick<Shape, 'type' | 'kind' | 'array' | 'identity'>,
  label: string,
  entries: readonly FieldPlan[],
): Shape {
  const plan = new Map<string, FieldPlan>()
  const fields: FieldPlan[] = []
  const ports: PortPlan[] = []
  const outputOrder = new Map<string, number>()
  const identity = field(table.identity.name, table.identity.type, {
    kind: 'identity',
    name: table.identity.name,
  })
  for (const entry of [identity, ...entries]) {
    if (entry.name.startsWith('@studio.'))
      throw problem('invalid-input', 'The @studio namespace is reserved.')
    if (plan.has(entry.name))
      throw problem('invalid-input', `${table.type}.${entry.name} is declared twice.`)
    plan.set(entry.name, entry)
    switch (entry.source.kind) {
      case 'identity':
        break
      case 'output':
        outputOrder.set(entry.name, outputOrder.size)
        break
      case 'port':
        ports.push(entry as PortPlan)
        break
      default:
        fields.push(entry)
    }
  }
  const generated: FieldDefinition[] = [
    { name: LABEL, kind: 'text', label: 'Identity' },
    ...[...DIAGRAM_POSITION, ...NETWORK_POSITION].map((name): FieldDefinition => ({
      name,
      kind: 'number',
      label: name,
    })),
  ]
  return {
    ...table,
    plan,
    fields,
    ports,
    outputOrder,
    definition: {
      name: table.type,
      label,
      identity: table.identity.name,
      labelField: plan.has('name') ? 'name' : LABEL,
      fields: [...plan.values()].map((item) => item.definition).concat(generated),
    },
  }
}
export function definitionsOf(
  shapes: readonly Shape[],
  supplied?: (table: string, field: string) => boolean,
): CaseDefinition {
  const position = (shape: Shape): [string, string] | undefined => {
    const fields = shape.fields.filter(
      (field) => field.geographic && field.definition.kind === 'number',
    )
    return fields.length >= 2 ? [fields[0]!.name, fields[1]!.name] : undefined
  }
  const joins = shapes.flatMap((shape) => {
    const ports = shape.ports.filter((port) => !port.definition.direction)
    return ports.length === 2 && ports[0]!.definition.target === ports[1]!.definition.target
      ? [
          {
            shape,
            target: ports[0]!.definition.target,
            ends: [ports[0]!.name, ports[1]!.name] as [string, string],
          },
        ]
      : []
  })
  const vertices = shapes.filter(
    (shape) =>
      joins.some((join) => join.target === shape.type) ||
      (!!position(shape) && !joins.some((join) => join.shape === shape)),
  )
  const geographic =
    vertices.length > 0 &&
    vertices.every((shape) => position(shape)) &&
    (!supplied ||
      vertices.some((shape) => position(shape)!.every((field) => supplied(shape.type, field))))
  const directed = shapes.flatMap((shape) =>
    shape.ports.filter((port) => port.definition.direction).map((port) => ({ shape, port })),
  )
  const nets = [...new Set(directed.map(({ port }) => port.definition.target))]
  const blocks = shapes.filter(
    (shape) => directed.some((item) => item.shape === shape) && !nets.includes(shape.type),
  )
  return {
    tables: shapes.map((shape) => shape.definition),
    drawing: {
      geographic,
      vertices: vertices.map((shape) => ({
        table: shape.type,
        label: shape.definition.labelField,
        position: geographic ? position(shape)! : [...NETWORK_POSITION],
      })),
      edges: joins
        .filter(
          ({ shape, target }) =>
            vertices.some((vertex) => vertex.type === target) && !vertices.includes(shape),
        )
        .map(({ shape, ends }) => ({
          table: shape.type,
          ends,
          bends: shape.fields.find(
            (field) =>
              field.geographic &&
              field.definition.kind === 'path' &&
              (!supplied || supplied(shape.type, field.name)),
          )?.name,
        })),
      blocks: blocks.map((shape) => ({
        table: shape.type,
        label: shape.definition.labelField,
        position: [...DIAGRAM_POSITION],
        ports: shape.ports
          .filter((port) => port.definition.direction)
          .map((port): [string, Port] => [
            port.name,
            {
              side: port.definition.direction === 'out' ? 'right' : 'left',
              output: port.definition.direction === 'out',
            },
          ]),
      })),
      nets,
    },
  }
}
export const catalog: Catalog = /* @__PURE__ */ catalogOf(models)
