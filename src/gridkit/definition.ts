/** GridKit catalog semantics and decoding rules, independent of how datasets are stored. */
import {
  type CaseDefinition,
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
type Identity = Shape['identity']
const IDENTITY: Readonly<Record<ArrayName, Identity>> = {
  buses: { name: 'number', type: 'unsigned' },
  signals: { name: 'signal_id', type: 'unsigned' },
  devices: { name: 'id', type: 'text' },
}
export const CLASS = 'class'
export const MON = 'mon'
/** The groups a bus or device keeps its values under, then its ports under. */
const VALUES = ['params', 'init', 'extension'] as const
const PORTS = ['ports', 'ports_in', 'ports_out'] as const
/** Members that identify or name a record. An output with one of these names is renamed. */
const NAMES: ReadonlySet<string> = new Set([
  ...Object.values(IDENTITY).map(({ name }) => name),
  'name',
  CLASS,
])
interface TextRule {
  readonly pattern: RegExp
  readonly rule: string
}
export interface FieldPlan {
  readonly name: string
  readonly definition: FieldDefinition
  readonly decode: DecodeKind
  readonly role: 'identity' | 'value' | 'port' | 'output'
  /** Keys from the record object to the value. An output's path is `mon`. */
  readonly path: readonly string[]
  readonly required?: boolean
  readonly choices?: readonly string[]
  readonly allowed?: TextRule
  readonly geographic?: boolean
}
interface PortPlan extends FieldPlan {
  readonly role: 'port'
  readonly definition: FieldDefinition & { readonly kind: 'reference'; readonly target: string }
  /** Undefined for a bus connection. */
  readonly direction?: 'in' | 'out'
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
  /** The outputs a record may list in its `mon`, in GridKit's order. */
  readonly outputs: readonly string[]
  readonly groups: readonly string[]
  /** Required members that are not fields, such as groups. Fields carry their own `required`. */
  readonly required: readonly string[]
}
export interface Catalog {
  readonly text: string
  readonly shapes: ReadonlyMap<string, Shape>
  readonly codes: readonly Shape[]
}
interface ValueSpec {
  readonly id: string
  readonly type: 'real' | 'integer' | 'flag' | 'text'
  readonly unit?: string
  readonly choices?: readonly string[]
  readonly required?: boolean
}
interface RecordSpec {
  readonly required?: readonly string[]
}
interface CaseSpec extends RecordSpec {
  readonly header?: readonly ValueSpec[]
  readonly params?: readonly ValueSpec[]
}
interface ClassSpec extends RecordSpec {
  readonly name: string
  readonly classes?: readonly string[]
  readonly label: string
  readonly params?: readonly ValueSpec[]
  readonly init?: readonly { readonly id: string; readonly unit?: string }[]
  readonly ports?: readonly {
    readonly key?: (typeof PORTS)[number]
    readonly required?: boolean
    readonly name: string
    readonly kind: 'bus' | 'signal'
    readonly direction: 'in' | 'out' | 'both'
  }[]
  readonly outputs?: readonly { readonly id: string; readonly unit?: string }[]
  readonly extension?: readonly {
    readonly id: string
    readonly type?: 'real' | 'flag' | 'route'
    readonly unit?: string
    readonly geographic?: boolean
  }[]
}
function value(path: readonly string[], decode: DecodeKind, unit?: string): FieldPlan {
  const name = path.join('.')
  return {
    name,
    decode,
    role: 'value',
    path,
    definition: {
      name,
      kind: decode === 'integer' || decode === 'unsigned' ? 'number' : decode,
      label: name,
      ...(unit !== undefined && { unit }),
    },
  }
}
/** Marks the required top-level fields, and returns the other required names as members. */
function requiring(
  entries: readonly FieldPlan[],
  required: readonly string[] = [],
): { entries: readonly FieldPlan[]; members: readonly string[] } {
  const own = (entry: FieldPlan) => entry.role === 'value' && entry.path.length === 1
  return {
    entries: entries.map((entry) =>
      own(entry) && required.includes(entry.path[0]!) ? { ...entry, required: true } : entry,
    ),
    members: required.filter(
      (name) => !entries.some((entry) => own(entry) && entry.path[0] === name),
    ),
  }
}
export function catalogOf(json: unknown): Catalog {
  const raw = json as {
    identifier?: { pattern?: unknown; rule?: unknown }
    case?: CaseSpec
    bus?: ClassSpec
    signal?: RecordSpec
    device?: RecordSpec
    classes?: ClassSpec[]
  } | null
  if (
    !raw?.case ||
    typeof raw.case !== 'object' ||
    typeof raw.bus?.name !== 'string' ||
    !Array.isArray(raw.classes)
  )
    throw problem('invalid-input', 'A catalog needs case, bus and classes entries.')
  const text = JSON.stringify(json)
  const identifier = identifierOf(raw.identifier)
  const { bus, device = {} } = raw
  const codes = [
    shapeOf(bus, 'bus', bus.name, identifier, bus.required),
    signalShape(raw.signal),
    ...raw.classes.map((spec) => shapeOf(spec, 'device', bus.name, identifier, device.required)),
  ]
  const shapes = new Map<string, Shape>()
  for (const shape of [...codes, caseShape(raw.case)]) {
    if (shapes.has(shape.type))
      throw problem('invalid-input', `The catalog declares ${shape.type} twice.`)
    shapes.set(shape.type, shape)
  }
  return { text, codes, shapes }
}
function identifierOf(
  raw: { pattern?: unknown; rule?: unknown } | undefined,
): TextRule | undefined {
  if (raw === undefined) return undefined
  if (typeof raw.pattern !== 'string' || typeof raw.rule !== 'string')
    throw problem('invalid-input', "A catalog's identifier has a pattern and a rule.")
  try {
    return { pattern: new RegExp(raw.pattern), rule: raw.rule }
  } catch {
    throw problem(
      'invalid-input',
      `The catalog's identifier pattern is not a valid regular expression: ${raw.pattern}`,
    )
  }
}
const DECODES = { flag: 'boolean', integer: 'integer', real: 'number', text: 'text' } as const
function valuesOf(type: string, group: string, specs: readonly ValueSpec[] = []): FieldPlan[] {
  return specs.map((spec) => {
    if (!Object.hasOwn(DECODES, spec.type))
      throw problem(
        'invalid-input',
        `${type}.${spec.id} is of type ${spec.type}, which is not real, integer, flag or text.`,
      )
    return {
      ...value([group, spec.id], DECODES[spec.type], spec.unit),
      ...(spec.choices && { choices: spec.choices }),
      ...(spec.required && { required: true }),
    }
  })
}
function shapeOf(
  spec: ClassSpec,
  kind: 'bus' | 'device',
  bus: string,
  identifier: TextRule | undefined,
  required: readonly string[] | undefined,
): Shape {
  const { params = [], init = [], ports = [], outputs = [] } = spec
  const parameters = new Set(params.map((param) => param.id))
  for (const port of ports)
    if (parameters.has(port.name))
      throw problem('invalid-input', `${spec.name}.${port.name} is both a parameter and a port.`)
  const array = kind === 'bus' ? 'buses' : 'devices'
  const { entries, members } = requiring(
    [
      // A bus's class is a field, like its name. A device's class selects its table.
      ...(kind === 'bus'
        ? [
            { ...value(['name'], 'text'), ...(identifier && { allowed: identifier }) },
            { ...value([CLASS], 'text'), choices: spec.classes ?? [spec.name] },
          ]
        : []),
      ...valuesOf(spec.name, 'params', params),
      ...init.map((init) => value(['init', init.id], 'number', init.unit)),
      ...(spec.extension ?? []).map((extension) => ({
        ...value(
          ['extension', extension.id],
          extension.type === 'flag' ? 'boolean' : extension.type === 'route' ? 'path' : 'number',
          extension.unit,
        ),
        geographic: extension.geographic,
      })),
      ...outputs.map((output): FieldPlan => {
        const name = NAMES.has(output.id) ? `${MON}.${output.id}` : output.id
        return {
          name,
          decode: 'number',
          role: 'output',
          path: [MON],
          // The label keeps GridKit's name even when the field is renamed to avoid a clash.
          definition: {
            name,
            label: output.id,
            kind: 'sampled',
            ...(output.unit !== undefined && { unit: output.unit }),
          },
        }
      }),
      ...ports.map((port): PortPlan => {
        const path = [port.key ?? PORTS[0], port.name]
        const name = path.join('.')
        return {
          name,
          decode: 'unsigned',
          role: 'port',
          path,
          required: port.required === true,
          ...(port.direction !== 'both' && { direction: port.direction }),
          definition: {
            name,
            // A bus's in and out ports share names, so the label includes the group.
            label: port.key ? name : port.name,
            kind: 'reference',
            target: port.kind === 'bus' ? bus : SIGNAL,
          },
        }
      }),
    ],
    required,
  )
  return compile(
    { type: spec.name, kind, array, identity: IDENTITY[array], groups: [...VALUES, ...PORTS] },
    spec.label,
    entries,
    members,
    kind === 'device' ? identifier : undefined,
  )
}
function signalShape(spec: RecordSpec = {}): Shape {
  const { entries, members } = requiring([value(['name'], 'text')], spec.required)
  return compile(
    { type: SIGNAL, kind: 'signal', array: 'signals', identity: IDENTITY.signals, groups: [] },
    SIGNAL,
    entries,
    members,
  )
}
function caseShape(spec: CaseSpec): Shape {
  const { entries, members } = requiring(
    [...valuesOf(CASE, 'header', spec.header), ...valuesOf(CASE, 'params', spec.params)],
    spec.required,
  )
  return compile(
    {
      type: CASE,
      kind: 'case',
      array: null,
      identity: { name: 'id', type: 'text' },
      groups: ['header', 'params'],
    },
    CASE,
    entries,
    members,
  )
}
/** The shape of an unknown device class. Its members are discovered while parsing. */
export function unknownShape(type: string): Shape {
  return compile(
    {
      type,
      kind: 'device',
      array: 'devices',
      identity: IDENTITY.devices,
      groups: [...VALUES, ...PORTS],
    },
    type,
    [],
  )
}
/** `shape` plus the unknown fields `found`. An output whose name clashes becomes `mon.<name>`. */
export function withFound(shape: Shape, found: readonly FieldPlan[]): Shape {
  const taken = new Set(found.map(({ name }) => name))
  return compile(
    shape,
    shape.definition.label,
    [...shape.plan.values()]
      .filter(({ role }) => role !== 'identity')
      .map((plan) =>
        plan.role === 'output' && taken.has(plan.name)
          ? {
              ...plan,
              name: `${MON}.${plan.name}`,
              definition: { ...plan.definition, name: `${MON}.${plan.name}` },
            }
          : plan,
      )
      .concat(found),
    shape.required,
    shape.plan.get(shape.identity.name)?.allowed,
  )
}
function compile(
  table: Pick<Shape, 'type' | 'kind' | 'array' | 'identity' | 'groups'>,
  label: string,
  entries: readonly FieldPlan[],
  required: readonly string[] = [],
  allowed?: TextRule,
): Shape {
  const plan = new Map<string, FieldPlan>()
  const fields: FieldPlan[] = []
  const ports: PortPlan[] = []
  const outputs: string[] = []
  const { name, type } = table.identity
  const identity: FieldPlan = {
    ...value([name], type),
    role: 'identity',
    ...(allowed && { allowed }),
  }
  for (const entry of [identity, ...entries]) {
    if (entry.name.startsWith('@studio.'))
      throw problem('invalid-input', 'The @studio namespace is reserved.')
    if (plan.has(entry.name))
      throw problem('invalid-input', `${table.type}.${entry.name} is declared twice.`)
    plan.set(entry.name, entry)
    if (entry.role === 'output') outputs.push(entry.name)
    else if (entry.role === 'port') ports.push(entry as PortPlan)
    else if (entry.role === 'value') fields.push(entry)
  }
  const generated: FieldDefinition[] = [
    { name: LABEL, kind: 'text', label: 'Identity' },
    ...NETWORK_POSITION.map((name): FieldDefinition => ({
      name,
      kind: 'number',
      label: name,
    })),
  ]
  return {
    type: table.type,
    kind: table.kind,
    array: table.array,
    identity: table.identity,
    groups: table.groups,
    required,
    plan,
    fields,
    ports,
    outputs,
    definition: {
      name: table.type,
      label,
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
    const ports = shape.ports.filter((port) => !port.direction)
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
    },
  }
}
export const catalog: Catalog = /* @__PURE__ */ catalogOf(models)
