type JsonObject = Record<string, unknown>

export interface CanonicalCase extends JsonObject {
  readonly header: JsonObject
  readonly params: JsonObject
  readonly buses: JsonObject[]
  readonly devices: JsonObject[]
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

export function canonicalCase(value: unknown): CanonicalCase {
  const input = object(value)
  const header = object(input['header'])
  const params = object(input['params'])
  const buses = Array.isArray(input['buses']) ? input['buses'] : []
  const devices = Array.isArray(input['devices']) ? input['devices'] : []
  const { header: _header, params: _params, buses: _buses, devices: _devices, ...rest } = input

  return {
    header: {
      format_version: 0.2,
      format_revision: 0,
      case_name: 'test',
      case_description: '',
      case_comments: '',
      ...header,
    },
    params: { freq_base: 60.0, va_base: 100_000_000.0, ...params },
    buses: buses.map((value, index) => {
      const bus = object(value)
      const number = typeof bus['number'] === 'number' ? bus['number'] : index
      return {
        class: 'Bus',
        name: String(number),
        number,
        params: {},
        ...bus,
      }
    }),
    devices: devices.map((value, index) => ({
      id: `device-${index}`,
      ports: {},
      params: {},
      ...object(value),
    })),
    ...rest,
  }
}

export function caseText(value: unknown, space?: number): string {
  return JSON.stringify(canonicalCase(value), null, space)
}

export function caseBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(caseText(value))
}
