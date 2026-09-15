import { connect, type Port, serve } from '@latkit/port'

import { tableProtocol, type TableReply } from './protocol.js'
import type { Table, TableView } from './query.js'

export function serveTable(port: Port, id: string, table: Table) {
  const views = new Map<string, TableView>()
  return serve(
    port,
    tableProtocol(id),
    async (request, signal): Promise<TableReply> => {
      if (request.type === 'query') {
        const view = await table.query(request.spec, signal)
        if (signal.aborted || views.size >= 8) {
          view.close()
          signal.throwIfAborted()
          throw new Error('Too many open table views.')
        }
        views.set(request.view, view)
        return {
          type: 'view',
          value: { id: request.view, total: view.total, frame: view.frame, time: view.time },
        }
      }
      const view = views.get(request.view)
      if (request.type === 'release') {
        view?.close()
        views.delete(request.view)
        return { type: 'released' }
      }
      if (!view) throw new Error('This table view has closed.')
      if (request.type === 'locate')
        return { type: 'position', value: await view.locate(request.element, signal) }
      return {
        type: 'rows',
        value: await view.read(request.offset, request.count, request.columns, signal),
      }
    },
    {
      onClose: () => {
        for (const view of views.values()) view.close()
        views.clear()
        table.close()
      },
    },
  )
}
export function connectTable(port: Port, id: string, rowCount: number): Table {
  const connection = connect(port, tableProtocol(id))
  let serial = 0
  return {
    rowCount,
    async query(spec, signal) {
      const requested = String(++serial)
      let reply: TableReply
      try {
        reply = await connection.call({ type: 'query', view: requested, spec }, { signal })
      } catch (error) {
        // The caller knows the lease ID even if cancellation races the query reply.
        void connection.call({ type: 'release', view: requested }).catch(() => {})
        throw error
      }
      if (reply.type !== 'view') throw new Error('Invalid table query reply.')
      let closed = false
      const info = reply.value
      return {
        ...info,
        async read(offset, count, columns, signal) {
          if (closed) throw new Error('This table view has closed.')
          const reply = await connection.call(
            { type: 'read', view: info.id, offset, count, columns },
            { signal },
          )
          if (reply.type !== 'rows') throw new Error('Invalid table window reply.')
          return reply.value
        },
        async locate(element, signal) {
          if (closed) throw new Error('This table view has closed.')
          const reply = await connection.call(
            { type: 'locate', view: info.id, element },
            { signal },
          )
          if (reply.type !== 'position') throw new Error('Invalid table position reply.')
          return reply.value
        },
        close() {
          if (closed) return
          closed = true
          void connection.call({ type: 'release', view: info.id }).catch(() => {})
        },
      }
    },
    close: () => connection.close(),
  }
}
