import { type Gpu } from '@latkit/gpu'
import { bitAt, type Data, type FieldValues, itemId, selectRows } from '@latkit/model'
import { createNetwork, type Network, type NetworkItem, type VertexOptions } from '@latkit/network'

import type { Element } from '../messages.js'
import { bridge } from './bridge.js'
import { nameFieldOf, networkOf } from './topology.js'
export function networkTopology(source: Data) {
  const drawn = networkOf(source.schema)
  const vertices: Record<string, VertexOptions> = {}
  for (const type of drawn.vertices) {
    const table = source.tables[type]
    const spatial = source.schema.types[type]!.spatial!.field
    let positioned = false
    for (const page of table?.fields[spatial] ?? []) {
      for (let row = 0; row < page.column.length; row++)
        if (!page.column.validity || bitAt(page.column.validity, page.column.offset + row)) {
          positioned = true
          break
        }
      if (positioned) break
    }
    let position: FieldValues | undefined
    if (table && !positioned) {
      const rows = table.rows
      const count = rows.kind === 'range' ? rows.count : rows.values.length
      const values = new Float64Array(count * 2)
      for (let row = 0; row < count; row++) {
        const angle = (row * 2 * Math.PI) / Math.max(1, count)
        values[row * 2] = 20 * Math.cos(angle)
        values[row * 2 + 1] = 20 * Math.sin(angle)
      }
      position = {
        index: table.index,
        rows,
        values: {
          kind: 'vector',
          size: 2,
          offset: 0,
          length: count,
          values: { kind: 'numeric', values, offset: 0, length: values.length },
        },
      }
    }
    vertices[type] = { labels: nameFieldOf(source.schema, type), ...(position ? { position } : {}) }
  }
  return {
    vertices,
    edges: Object.fromEntries(
      drawn.edges.map(({ type, ends, bends }) => [type, { ends, ...(bends ? { bends } : {}) }]),
    ),
  }
}
export function mountNetwork(gpu: Gpu, canvas: HTMLCanvasElement, source: Data, style: object) {
  const network = createNetwork(gpu, { canvas, source, ...networkTopology(source), ...style })
  network.on('select', (items) => {
    const item = items[0]
    if (item) {
      const id = itemId(item)
      if (id) bridge.send({ kind: 'select', element: { id } })
    }
  })
  network.on('contextmenu', (event) => {
    const item = event.items[0]
    if (item) bridge.send({ kind: 'select', element: { id: itemId(item) } })
    bridge.send({ kind: 'overlap', elements: event.items.map((item) => ({ id: itemId(item) })) })
  })
  network.on('open', (item) => {
    bridge.send({ kind: 'select', element: { id: itemId(item) } })
    bridge.command('elementSource')
  })
  return network
}
export function networkItem(network: Network, element: Element): NetworkItem | undefined {
  const source = network.config.source
  const type = element.id.split('/')[0]!
  const table = source.tables[type]
  if (!table) return
  const rows = selectRows(table, { kind: 'ids', ids: [element.id] })
  const row = rows.kind === 'range' ? (rows.count ? rows.offset : undefined) : rows.values[0]
  if (row === undefined) return
  const kind = network.config.vertices[type]
    ? 'vertex'
    : network.config.edges?.[type]
      ? 'edge'
      : undefined
  return kind ? { kind, source, index: table.index, row } : undefined
}
