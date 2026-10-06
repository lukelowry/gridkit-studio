/** Whether a case places its network itself, read from its rows. */

import { type Data, numberAt } from '@latkit/model'

import { networkOf, positionOf } from './schema.js'

const found = new WeakMap<Data, boolean>()

/** Whether some row of `type` reads a number in `field`. */
function numbered(source: Data, type: string, field: string): boolean {
  for (const { column } of source.tables[type]?.fields[field] ?? [])
    if (column.kind === 'numeric')
      for (let row = 0; row < column.length; row++)
        if (Number.isFinite(numberAt(column, row))) return true
  return false
}

/** Whether some vertex of `source` has a position of its own. Without one, the network lays every
 *  vertex out itself, on a plane. */
export function located(source: Data): boolean {
  let result = found.get(source)
  if (result === undefined) {
    result = networkOf(source.schema).vertices.some((type) => {
      const position = positionOf(source.schema, type)
      return !!position && numbered(source, type, position.x) && numbered(source, type, position.y)
    })
    found.set(source, result)
  }
  return result
}
