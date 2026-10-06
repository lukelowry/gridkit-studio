/** Turn the diagram's editing gestures into transactions on the case document. */

import { arrange, type Diagram } from '@latkit/diagram'
import type { Gpu, Positions } from '@latkit/gpu'
import { itemId, numberAt, rowAt, rowCount } from '@latkit/model'

import type { Mutation, ViewState } from '../../shared/messages.js'
import { reader } from '../../shared/preferences.js'
import { bridge } from '../bridge.js'
import { layoutOf } from './options.js'

/** The moves that put each block where `positions` says. */
function moves(diagram: Diagram, positions: Readonly<Record<string, Positions>>): Mutation[] {
  const changes: Mutation[] = []
  for (const { x, y } of Object.values(positions)) {
    if (x.values.kind !== 'numeric' || y.values.kind !== 'numeric') continue
    for (let index = 0; index < rowCount(x.rows); index++) {
      const id = itemId({
        source: diagram.config.source,
        index: x.index,
        row: rowAt(x.rows, index),
      })
      const left = numberAt(x.values, index)
      const top = numberAt(y.values, index)
      if (left !== null && top !== null && Number.isFinite(left) && Number.isFinite(top))
        changes.push({ kind: 'move', id, position: [left, top] })
    }
  }
  return changes
}

/** Commits `diagram`'s edits to the case, telling `refuse` why one did not happen; returns a
 *  function that arranges every block and commits the result. */
export function editing(
  diagram: Diagram,
  gpu: Gpu,
  state: () => ViewState,
  signal: AbortSignal,
  refuse: (reason: unknown) => void,
) {
  let busy = false
  const refused = (error: unknown) => {
    if (!signal.aborted) refuse(error)
  }
  async function commit(changes: Mutation[], label: string, expected = state().summary?.version) {
    signal.throwIfAborted()
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
      refused('Start a connection at a signal port.')
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
    ).catch(refused)
  })
  diagram.on('move', (proposal) => {
    // Latkit includes the automatically placed neighbors, keeping the drawing stable on accept.
    void commit(moves(diagram, proposal.positions), 'Move diagram blocks').catch(refused)
  })
  diagram.on('delete', (items) => {
    if (items.length)
      void commit(
        [{ kind: 'remove', ids: items.map((item) => itemId(item)) }],
        'Delete diagram elements',
      ).catch(refused)
  })
  return async () => {
    const expected = state().summary?.version
    const layout = layoutOf(reader(state().settings))
    const positions = await arrange(gpu, { ...diagram.config, layout }, { signal })
    await commit(moves(diagram, positions), 'Arrange diagram', expected)
  }
}
