import { problem } from './ai.js'
import type { JsonSchema } from './tools.js'

/** Validate the JSON Schema vocabulary used by the canonical catalog in native chat too. */
export function validateInput(schema: JsonSchema, value: unknown, path = 'input'): void {
  const fail = (reason: string): never => {
    throw problem('invalid-input', `${path}: ${reason}`)
  }
  for (const keyword of ['oneOf', 'anyOf']) {
    const alternatives = schema[keyword] as JsonSchema[] | undefined
    if (!alternatives) continue
    let matches = 0
    for (const choice of alternatives) {
      try {
        validateInput(choice, value, path)
        matches++
      } catch {
        /* Try another schema branch. */
      }
    }
    if (!matches || (keyword === 'oneOf' && matches !== 1))
      fail('does not match the expected shape')
  }
  if ('const' in schema && value !== schema.const) fail(`expected ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail('unsupported value')
  const types =
    typeof schema.type === 'string' ? [schema.type] : (schema.type as string[] | undefined)
  if (
    types &&
    !types.some((type) =>
      type === 'null'
        ? value === null
        : type === 'array'
          ? Array.isArray(value)
          : type === 'object'
            ? !!value && typeof value === 'object' && !Array.isArray(value)
            : type === 'integer'
              ? Number.isSafeInteger(value)
              : type === 'number'
                ? typeof value === 'number' && Number.isFinite(value)
                : typeof value === type,
    )
  )
    fail('incorrect value type')
  if (
    typeof value === 'string' &&
    typeof schema.minLength === 'number' &&
    value.length < schema.minLength
  )
    fail('cannot be empty')
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      fail(`minimum is ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      fail(`maximum is ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
      fail(`must exceed ${schema.exclusiveMinimum}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail('too few items')
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      fail('too many items')
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      fail('duplicate items')
    if (schema.items)
      value.forEach((item, index) =>
        validateInput(schema.items as JsonSchema, item, `${path}[${index}]`),
      )
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const properties = schema.properties as Record<string, JsonSchema> | undefined
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!(key in record)) fail(`missing ${key}`)
    for (const [key, item] of Object.entries(record)) {
      if (properties?.[key]) validateInput(properties[key], item, `${path}.${key}`)
      else if (schema.additionalProperties === false) fail(`unknown property ${key}`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        validateInput(schema.additionalProperties as JsonSchema, item, `${path}.${key}`)
    }
  }
}
