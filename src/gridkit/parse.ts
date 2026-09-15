import { createHash } from 'node:crypto'

import {
  type ClassData,
  type ClassSpec,
  type Column,
  createModel,
  fieldKey,
  type Model,
  type Signal,
  type Topology,
} from '@latkit/model'

import { canonicalMonitor, classLabel, classMonitors } from './classes.js'
import { caseId, classId } from './ids.js'
import {
  type Bus,
  type Case,
  type Device,
  type Signal as CaseSignal,
  validate,
} from './validate.js'

interface Field {
  readonly key: string
  readonly block: 'top' | 'init' | 'params' | 'ports' | 'extension'
}

const BLOCK_GROUP: Record<Field['block'], string | undefined> = {
  top: undefined,
  init: 'Initial state',
  params: 'Parameters',
  ports: 'Ports',
  extension: 'Extension',
}

type CaseRecord = Bus | CaseSignal | Device

interface ClassRecords {
  readonly className: string
  readonly kind: 'bus' | 'signal' | 'device'
  readonly elements: readonly CaseRecord[]
  readonly fields: readonly Field[]
}

const NONE = 0xffffffff

function readMeta(caseJson: Case): Model['meta'] {
  const header = caseJson.header
  return {
    formatVersion: header.format_version,
    formatRevision: header.format_revision,
    ...(header.case_date_time !== undefined && { caseDateTime: header.case_date_time }),
    description: header.case_description,
    comments: header.case_comments,
    frequencyBaseHz: caseJson.params.freq_base,
    powerBaseVa: caseJson.params.va_base,
  }
}

function readTopology(caseJson: Case, rows: Map<number, number>): Topology {
  const buses = caseJson.buses
  const coords = new Float32Array(buses.length * 2)
  // Use geographic coordinates only when every bus has them.
  let coordsComplete = buses.length > 0
  buses.forEach((bus, row) => {
    const lon = bus.extension?.['longitude']
    const lat = bus.extension?.['latitude']
    if (coordsComplete && typeof lon === 'number' && typeof lat === 'number') {
      coords[row * 2] = lon
      coords[row * 2 + 1] = lat
    } else {
      coordsComplete = false
    }
  })

  const edges: number[] = []
  const polylineStart: number[] = [0]
  const polylinePoints: number[] = []
  for (const device of caseJson.devices) {
    if (device.class !== 'Branch') continue
    const bus1 = device.ports['bus1']
    const bus2 = device.ports['bus2']
    const from = rows.get(bus1 as number)
    const to = rows.get(bus2 as number)
    edges.push(from!, to!)
    const line = device.extension?.['polyline']
    if (coordsComplete && Array.isArray(line)) {
      for (const point of line as [number, number][]) polylinePoints.push(point[0], point[1])
    }
    polylineStart.push(polylinePoints.length / 2)
  }
  return {
    vertexCount: buses.length,
    coordinateSpace: coordsComplete ? 'geographic' : 'cartesian',
    ...(coordsComplete && { vertexCoords: coords }),
    edges: Uint32Array.from(edges),
    polylineStart: Uint32Array.from(polylineStart),
    ...(polylinePoints.length > 0 && { polylinePoints: Float32Array.from(polylinePoints) }),
  }
}

const BUS_STRUCTURAL = new Set(['number', 'class', 'name', 'init', 'params', 'mon', 'extension'])
const DEVICE_STRUCTURAL = new Set(['class', 'id', 'ports', 'params', 'init', 'mon', 'extension'])

function classFields(
  kind: ClassRecords['kind'],
  elements: readonly CaseRecord[],
): readonly Field[] {
  const fields: Field[] = []
  const seen = new Set<string>()
  const add = (key: string, block: Field['block']): void => {
    const id = `${block}.${key}`
    if (seen.has(id)) return
    seen.add(id)
    fields.push({ key, block })
  }
  const addBlock = (block: Exclude<Field['block'], 'top'>): void => {
    for (const element of elements) {
      const map = (element as unknown as Record<string, unknown>)[block]
      if (map && typeof map === 'object') for (const key of Object.keys(map)) add(key, block)
    }
  }
  if (kind === 'bus') {
    add('number', 'top')
    add('class', 'top')
    add('name', 'top')
    for (const element of elements) {
      for (const key of Object.keys(element)) if (!BUS_STRUCTURAL.has(key)) add(key, 'top')
    }
    addBlock('init')
    addBlock('params')
    addBlock('extension')
  } else if (kind === 'signal') {
    add('signal_id', 'top')
    add('name', 'top')
  } else {
    add('class', 'top')
    add('id', 'top')
    for (const element of elements) {
      for (const key of Object.keys(element)) if (!DEVICE_STRUCTURAL.has(key)) add(key, 'top')
    }
    addBlock('ports')
    addBlock('init')
    addBlock('params')
    addBlock('extension')
  }
  return fields
}

function groupRecords(caseJson: Case): ClassRecords[] {
  const groups: ClassRecords[] = []
  if (caseJson.buses.length > 0) {
    groups.push({
      className: 'Bus',
      kind: 'bus',
      elements: caseJson.buses,
      fields: classFields('bus', caseJson.buses),
    })
  }
  const signals = caseJson.signals ?? []
  if (signals.length > 0) {
    groups.push({
      className: 'Signal',
      kind: 'signal',
      elements: signals,
      fields: classFields('signal', signals),
    })
  }
  const order: string[] = []
  const byClass = new Map<string, Device[]>()
  for (const device of caseJson.devices) {
    let bucket = byClass.get(device.class)
    if (!bucket) {
      bucket = []
      byClass.set(device.class, bucket)
      order.push(device.class)
    }
    bucket.push(device)
  }
  for (const className of order) {
    const elements = byClass.get(className)!
    groups.push({ className, kind: 'device', elements, fields: classFields('device', elements) })
  }
  return groups
}

function classSignals(group: ClassRecords): readonly Signal[] {
  const recorded: string[] = []
  const seen = new Set<string>()
  for (const element of group.elements) {
    const mon = (element as { readonly mon?: unknown }).mon
    if (!Array.isArray(mon)) continue
    for (const raw of mon) {
      if (typeof raw !== 'string') continue
      const key = canonicalMonitor(group.className, raw)
      if (!seen.has(key)) {
        seen.add(key)
        recorded.push(key)
      }
    }
  }
  // Preserve catalog order and append unknown recorded names.
  const catalog = classMonitors(group.className)
  const signals: Signal[] = catalog.map((id) => ({
    id,
    label: id,
    unit: '',
    recorded: seen.has(id),
  }))
  const known = new Set(catalog)
  for (const id of recorded)
    if (!known.has(id)) signals.push({ id, label: id, unit: '', recorded: true })
  return signals
}

function deviceAnchor(
  elements: readonly CaseRecord[],
  rows: Map<number, number>,
): ClassSpec['anchor'] {
  const index = new Uint32Array(elements.length).fill(NONE)
  let placed = false
  elements.forEach((element, at) => {
    const row = rows.get((element as Device).ports?.['bus'] as number)
    if (row !== undefined) {
      index[at] = row
      placed = true
    }
  })
  return placed ? { kind: 'vertex', index } : undefined
}

function makeClass(group: ClassRecords, rows: Map<number, number>): ClassSpec {
  const anchor =
    group.kind === 'device' && group.className !== 'Branch'
      ? deviceAnchor(group.elements, rows)
      : undefined
  return {
    id: classId(group.className),
    label: classLabel(group.className),
    count: group.elements.length,
    ...(anchor && { anchor }),
    signals: classSignals(group),
  }
}

export interface ParsedCase {
  readonly raw: Case
  readonly model: Model
  /** Digest of the case without `mon` arrays. Equal digests share simulation results. */
  readonly inputIdentity: string
  readonly monitoring: Monitoring
}

export type Monitoring = ReadonlyMap<string, ReadonlySet<number>>

export function indexMonitoring(raw: Case): Monitoring {
  const result = new Map<string, Set<number>>()
  const counts = new Map<string, number>()
  const add = (element: Bus | Device, id: string) => {
    const index = counts.get(id) ?? 0
    counts.set(id, index + 1)
    for (const name of element.mon ?? []) {
      const key = fieldKey({
        classId: id,
        source: 'signal',
        id: canonicalMonitor(element.class, name),
      })
      const elements = result.get(key) ?? new Set<number>()
      elements.add(index)
      result.set(key, elements)
    }
  }
  raw.buses.forEach((bus) => add(bus, 'bus'))
  raw.devices.forEach((device) => add(device, classId(device.class)))
  return result
}

function inputIdentity(raw: Case): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...raw,
        buses: raw.buses.map(({ mon: _, ...bus }) => bus),
        devices: raw.devices.map(({ mon: _, ...device }) => device),
      }),
    )
    .digest('hex')
}

export function parse(bytes: Uint8Array): ParsedCase {
  const text = new TextDecoder().decode(bytes)
  const raw = validate(JSON.parse(text))
  const rows = new Map(raw.buses.map((bus, row) => [bus.number, row]))
  const groups = groupRecords(raw)
  const byId = new Map(groups.map((group) => [classId(group.className), group]))
  const name = raw.header.case_name
  const hasBranches = raw.devices.some((device) => device.class === 'Branch')
  const model = createModel(
    {
      vendor: 'gridkit',
      id: caseId(name, bytes),
      name,
      meta: readMeta(raw),
      topology: readTopology(raw, rows),
      owners: {
        ...(raw.buses.length > 0 && { vertex: 'bus' }),
        ...(hasBranches && { edge: 'branch' }),
      },
      classes: groups.map((group) => makeClass(group, rows)),
    },
    {
      load: async (id) => {
        const group = byId.get(id)
        if (!group) throw new Error(`GridKit: unknown class '${id}'`)
        return classData(group)
      },
      bytes: async () => bytes,
    },
  )
  return {
    raw,
    model,
    inputIdentity: inputIdentity(raw),
    monitoring: indexMonitoring(raw),
  }
}

function elementLabel(group: ClassRecords, index: number): string {
  const element = group.elements[index]!
  const identity =
    group.kind === 'bus'
      ? (element as Bus).number
      : group.kind === 'signal'
        ? (element as CaseSignal).signal_id
        : (element as Device).id
  const text = identity === undefined || identity === null ? '' : String(identity)
  return text ? text : `#${index}`
}

function readKey(element: CaseRecord, field: Field): unknown {
  const record = element as unknown as Record<string, unknown>
  const source =
    field.block === 'top' ? record : (record[field.block] as Record<string, unknown> | undefined)
  return source?.[field.key]
}

function columnOf(group: ClassRecords, field: Field): Column | null {
  const values = group.elements.map((element) => readKey(element, field))
  const defined = values.filter((value) => value !== undefined && value !== null)
  const section = BLOCK_GROUP[field.block]
  const base = {
    id: `${field.block}.${field.key}`,
    label: field.key,
    ...(section !== undefined && { group: section }),
  }
  // Columns hold scalars; nested extension data stays in the original case.
  if (defined.some((value) => typeof value === 'object')) return null
  if (defined.every((value) => typeof value === 'number')) {
    return {
      kind: 'number',
      ...base,
      values: Float64Array.from(values, (value) => (typeof value === 'number' ? value : NaN)),
    }
  }
  if (defined.every((value) => typeof value === 'boolean')) {
    return {
      kind: 'flag',
      ...base,
      values: Uint8Array.from(values, (value) => (value === true ? 1 : 0)),
    }
  }
  return {
    kind: 'text',
    ...base,
    values: values.map((value) => (value === undefined || value === null ? null : String(value))),
  }
}

function classData(group: ClassRecords): ClassData {
  return {
    labels: group.elements.map((_, index) => elementLabel(group, index)),
    columns: group.fields.flatMap((field) => columnOf(group, field) ?? []),
  }
}
