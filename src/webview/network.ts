import { type Gpu } from '@latkit/gpu'
import { type Data, type FieldValues, itemId, selectRows } from '@latkit/model'
import { createNetwork, type Network, type NetworkItem, type VertexOptions } from '@latkit/network'

import type { Element, ViewState } from '../messages.js'
import { bridge } from './bridge.js'
import { nativeMenu } from './context.js'
import { networkOf } from './topology.js'
export function networkTopology(source: Data, positions: Record<string, FieldValues> = {}) {
  const drawn = networkOf(source.schema)
  const vertices: Record<string, VertexOptions> = {}
  for (const type of drawn.vertices) {
    const position = positions[type]
    vertices[type] = position ? { position } : {}
  }
  return {
    vertices,
    edges: Object.fromEntries(
      drawn.edges.map(({ type, ends, bends }) => [
        type,
        { ends, ...(bends && !Object.keys(positions).length ? { bends } : {}) },
      ]),
    ),
  }
}
export function mountNetwork(
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  source: Data,
  style: Parameters<Network['set']>[0],
  state: () => ViewState,
  positions: Record<string, FieldValues> = {},
) {
  const topology = networkTopology(source, positions)
  const network = createNetwork(gpu, { canvas, source, ...topology })
  // Apply the complete style synchronously, before the renderer can prepare its first frame.
  network.set(style)
  network.on('select', (items) => {
    const item = items[0]
    if (item) {
      const id = itemId(item)
      if (id) bridge.send({ kind: 'select', element: { id } })
    }
  })
  network.on('contextmenu', (event) =>
    nativeMenu(
      canvas,
      event.point,
      event.items.map((item) => ({ id: itemId(item) })),
      state(),
      'network',
    ),
  )
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
