import { arrange, type Diagram } from '@latkit/diagram'
import type { Gpu } from '@latkit/gpu'
import { type FieldValues, itemId, numberAt, rowAt, rowCount } from '@latkit/model'

import type { Mutation, ViewState } from '../messages.js'
import { reader } from '../preferences.js'
import { bridge } from './bridge.js'
function moves(diagram: Diagram, positions: Readonly<Record<string, FieldValues>>): Mutation[] {
  const changes: Mutation[] = []
  for (const field of Object.values(positions)) {
    if (field.values.kind !== 'vector') continue
    for (let index = 0; index < rowCount(field.rows); index++) {
      const id = itemId({
        source: diagram.config.source,
        index: field.index,
        row: rowAt(field.rows, index),
      })
      const offset = (field.values.offset + index) * field.values.size - field.values.values.offset
      const x = numberAt(field.values.values, offset)
      const y = numberAt(field.values.values, offset + 1)
      if (x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y))
        changes.push({ kind: 'move', id, position: [x, y] })
    }
  }
  return changes
}
const report = (error: unknown) => {
  const status = document.querySelector<HTMLElement>('.status')
  if (status) {
    status.textContent = String(error)
    status.setAttribute('role', 'alert')
  }
  bridge.send({ kind: 'error', message: String(error) })
}
export function editing(diagram: Diagram, gpu: Gpu, state: () => ViewState) {
  let busy = false
  async function commit(changes: Mutation[], label: string, expected = state().summary?.version) {
    const current = state()
    if (
      busy ||
      current.stale ||
      !current.writable ||
      !current.summary ||
      current.summary.version !== expected
    )
      throw new Error('Wait for the current document revision before editing.')
    busy = true
    try {
      await bridge.request('transact', {
        version: current.summary.version,
        mutations: changes,
        label,
      })
    } finally {
      busy = false
    }
  }
  diagram.on('connect', (proposal) => {
    if (proposal.from.kind !== 'port') {
      report('Start a connection at a signal port.')
      return
    }
    const from = { id: itemId(proposal.from), field: proposal.from.port }
    const to = proposal.to
      ? {
          id: itemId(proposal.to),
          ...(proposal.to.kind === 'port' ? { field: proposal.to.port } : {}),
        }
      : null
    void commit(
      [{ kind: 'connect', from, to }],
      to ? 'Connect signal ports' : 'Disconnect signal port',
    ).catch(report)
  })
  diagram.on('move', (proposal) => {
    const expected = state().summary?.version
    void (async () => {
      const existing = Object.values(diagram.config.vertices).some((vertex) => vertex.position)
      const all = existing ? [] : moves(diagram, await arrange(gpu, diagram.config))
      const changes = new Map(all.map((change) => ['id' in change ? change.id : '', change]))
      for (const move of proposal.moves)
        changes.set(itemId(move.vertex), {
          kind: 'move',
          id: itemId(move.vertex),
          position: move.position,
        })
      await commit([...changes.values()], 'Move diagram blocks', expected)
    })().catch(report)
  })
  diagram.on('delete', (items) => {
    if (items.length)
      void commit(
        [{ kind: 'remove', ids: items.map((item) => itemId(item)) }],
        'Delete diagram elements',
      ).catch(report)
  })
  return async () => {
    const expected = state().summary?.version
    const s = reader(state().settings)
    const positions = await arrange(gpu, {
      ...diagram.config,
      layout: {
        algorithm: s.get('diagram.layout.algorithm'),
        direction: s.get('diagram.layout.direction'),
        vertexGap: s.get('diagram.layout.vertexGap'),
        rankGap: s.get('diagram.layout.rankGap'),
        sweeps: s.get('diagram.layout.sweeps'),
      },
    })
    await commit(moves(diagram, positions), 'Arrange diagram', expected)
  }
}
