import { classId } from './ids.js'

interface Header {
  readonly format_version: 0.2
  readonly format_revision: 0
  readonly case_name: string
  readonly case_date_time?: string
  readonly case_description: string
  readonly case_comments: string
}

interface SystemParams {
  readonly freq_base: number
  readonly va_base: number
}

export interface Bus {
  readonly number: number
  readonly class: 'Bus' | 'BusInfinite'
  readonly name: string
  readonly init?: Record<string, unknown>
  readonly params: Record<string, unknown>
  readonly mon?: readonly string[]
  readonly extension?: Record<string, unknown>
}

export interface Device {
  readonly class: string
  readonly id: string
  readonly ports: Record<string, unknown>
  readonly params: Record<string, unknown>
  readonly init?: Record<string, unknown>
  readonly mon?: readonly string[]
  readonly extension?: Record<string, unknown>
}

export interface Signal {
  readonly signal_id: number
  readonly name: string
}

interface MonitorSink {
  readonly file_name?: string
  readonly format: string
  readonly delim?: string
}

export interface Case {
  readonly header: Header
  readonly params: SystemParams
  readonly buses: readonly Bus[]
  readonly signals?: readonly Signal[]
  readonly devices: readonly Device[]
  readonly monitors?: readonly MonitorSink[]
}

type Path = readonly (string | number)[]
type JsonObject = Record<string, unknown>

export class CaseError extends Error {
  constructor(
    readonly path: Path,
    reason: string,
  ) {
    const location = path.reduce<string>(
      (text, key) =>
        text +
        (typeof key === 'number'
          ? `[${key}]`
          : /^[A-Za-z_]\w*$/.test(key)
            ? `.${key}`
            : `[${JSON.stringify(key)}]`),
      '$',
    )
    super(`GridKit: ${location} ${reason}`)
  }
}

function invalid(path: Path, reason: string): never {
  throw new CaseError(path, reason)
}

function expectObject(value: unknown, path: Path): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(path, 'must be an object')
  return value as JsonObject
}

function expectArray(value: unknown, path: Path): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'must be an array')
  return value
}

function required(object: JsonObject, key: string, path: Path): unknown {
  if (!Object.hasOwn(object, key)) invalid([...path, key], 'is required')
  return object[key]
}

function expectString(value: unknown, path: Path): string {
  if (typeof value !== 'string') invalid(path, 'must be a string')
  return value
}

function expectNumber(value: unknown, path: Path): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'must be a finite number')
  return value
}

function expectIndex(value: unknown, path: Path): number {
  const number = expectNumber(value, path)
  if (!Number.isSafeInteger(number) || number < 0)
    invalid(path, 'must be a non-negative safe integer')
  return number
}

function validateValues(value: unknown, path: Path, flags = false): void {
  for (const [key, member] of Object.entries(expectObject(value, path))) {
    if (!flags || typeof member !== 'boolean') expectNumber(member, [...path, key])
  }
}

function validateRecord(record: JsonObject, path: Path): void {
  validateValues(required(record, 'params', path), [...path, 'params'], true)
  if (Object.hasOwn(record, 'init')) validateValues(record.init, [...path, 'init'])
  if (Object.hasOwn(record, 'mon')) {
    expectArray(record.mon, [...path, 'mon']).forEach((value, index) =>
      expectString(value, [...path, 'mon', index]),
    )
  }
  if (Object.hasOwn(record, 'extension')) expectObject(record.extension, [...path, 'extension'])
}

function validateHeader(root: JsonObject): void {
  const header = expectObject(required(root, 'header', []), ['header'])
  if (required(header, 'format_version', ['header']) !== 0.2)
    invalid(['header', 'format_version'], 'must be 0.2')
  if (required(header, 'format_revision', ['header']) !== 0)
    invalid(['header', 'format_revision'], 'must be 0')
  for (const key of ['case_name', 'case_description', 'case_comments']) {
    expectString(required(header, key, ['header']), ['header', key])
  }
  if (Object.hasOwn(header, 'case_date_time'))
    expectString(header.case_date_time, ['header', 'case_date_time'])
  const params = expectObject(required(root, 'params', []), ['params'])
  for (const key of ['freq_base', 'va_base'])
    expectNumber(required(params, key, ['params']), ['params', key])
}

function validateBuses(root: JsonObject): void {
  const numbers = new Set<number>()
  expectArray(required(root, 'buses', []), ['buses']).forEach((entry, index) => {
    const path: Path = ['buses', index]
    const bus = expectObject(entry, path)
    const number = expectIndex(required(bus, 'number', path), [...path, 'number'])
    if (numbers.has(number)) invalid([...path, 'number'], `duplicates bus ${number}`)
    numbers.add(number)
    const name = expectString(required(bus, 'class', path), [...path, 'class'])
    if (name !== 'Bus' && name !== 'BusInfinite')
      invalid([...path, 'class'], 'must be exactly Bus or BusInfinite')
    expectString(required(bus, 'name', path), [...path, 'name'])
    validateRecord(bus, path)
    const extension = bus.extension as JsonObject | undefined
    for (const key of ['longitude', 'latitude']) {
      if (extension && Object.hasOwn(extension, key))
        coordinate(extension[key], [...path, 'extension', key])
    }
  })
}

function coordinate(value: unknown, path: Path): void {
  const number = expectNumber(value, path)
  if (!Number.isFinite(Math.fround(number)))
    invalid(path, 'is outside the supported coordinate range')
}

function validateSignals(root: JsonObject): void {
  if (!Object.hasOwn(root, 'signals')) return
  const ids = new Set<number>()
  expectArray(root.signals, ['signals']).forEach((entry, index) => {
    const path: Path = ['signals', index]
    const signal = expectObject(entry, path)
    const id = expectIndex(required(signal, 'signal_id', path), [...path, 'signal_id'])
    if (ids.has(id)) invalid([...path, 'signal_id'], `duplicates signal ${id}`)
    ids.add(id)
    expectString(required(signal, 'name', path), [...path, 'name'])
  })
}

function validateDevices(root: JsonObject): void {
  const idsByClass = new Map<string, Set<string>>()
  expectArray(required(root, 'devices', []), ['devices']).forEach((entry, index) => {
    const path: Path = ['devices', index]
    const device = expectObject(entry, path)
    const name = expectString(required(device, 'class', path), [...path, 'class'])
    const id = expectString(required(device, 'id', path), [...path, 'id'])
    const ids = idsByClass.get(name) ?? new Set<string>()
    if (ids.has(id)) invalid([...path, 'id'], `duplicates ${name} device '${id}'`)
    ids.add(id)
    idsByClass.set(name, ids)
    const ports = expectObject(required(device, 'ports', path), [...path, 'ports'])
    for (const [key, value] of Object.entries(ports)) expectIndex(value, [...path, 'ports', key])
    validateRecord(device, path)
    const extension = device.extension as JsonObject | undefined
    if (name === 'Branch' && extension && Object.hasOwn(extension, 'polyline')) {
      expectArray(extension.polyline, [...path, 'extension', 'polyline']).forEach((point, at) => {
        const location = [...path, 'extension', 'polyline', at]
        const pair = expectArray(point, location)
        if (pair.length !== 2) invalid(location, 'must contain two coordinates')
        pair.forEach((value, axis) => coordinate(value, [...location, axis]))
      })
    }
  })
}

function validateReferences(value: Case): void {
  const buses = new Set(value.buses.map((bus) => bus.number))
  const names = new Map<string, string>()
  if (value.buses.length) names.set('bus', 'Bus')
  if (value.signals?.length) names.set('signal', 'Signal')
  const seen = new Set<string>()
  value.devices.forEach((device, index) => {
    const path: Path = ['devices', index]
    if (!seen.has(device.class)) {
      const id = classId(device.class)
      const previous = names.get(id)
      if (previous !== undefined)
        invalid(
          [...path, 'class'],
          `class '${device.class}' collides with '${previous}' as '${id}'`,
        )
      names.set(id, device.class)
      seen.add(device.class)
    }
    // Other numeric ports can refer to signals, not buses.
    const keys =
      device.class === 'Branch'
        ? ['bus1', 'bus2']
        : Object.hasOwn(device.ports, 'bus')
          ? ['bus']
          : []
    for (const key of keys) {
      const number = required(device.ports, key, [...path, 'ports'])
      if (!buses.has(number as number))
        invalid([...path, 'ports', key], `references unknown bus ${number}`)
    }
  })
}

const SINK_FORMATS = new Set(['CSV', 'JSON', 'YAML', 'ARROW', 'ARROW_STREAM'])

function validateMonitors(root: JsonObject): void {
  if (!Object.hasOwn(root, 'monitors')) return
  expectArray(root.monitors, ['monitors']).forEach((entry, index) => {
    const path: Path = ['monitors', index]
    const monitor = expectObject(entry, path)
    const format = expectString(required(monitor, 'format', path), [...path, 'format'])
    if (!SINK_FORMATS.has(format.toUpperCase())) invalid([...path, 'format'], 'is unsupported')
    for (const key of ['file_name', 'delim']) {
      if (Object.hasOwn(monitor, key)) expectString(monitor[key], [...path, key])
    }
    if (Object.hasOwn(monitor, 'batch_rows'))
      expectIndex(monitor.batch_rows, [...path, 'batch_rows'])
  })
}

export function validate(value: unknown): Case {
  const root = expectObject(value, [])
  validateHeader(root)
  validateBuses(root)
  validateSignals(root)
  validateDevices(root)
  validateMonitors(root)
  const result = root as unknown as Case
  validateReferences(result)
  return result
}
