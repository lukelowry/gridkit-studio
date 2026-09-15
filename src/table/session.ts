import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { ClassData } from '@latkit/model'
import { connect, type Port } from '@latkit/port'

import { workerPort } from '../csv/port.js'
import { openTableProtocol } from './protocol.js'
import { connectTable } from './transport.js'

export function tableOpener(port: Port) {
  const connection = connect(port, openTableProtocol)
  return {
    async open(
      data: ClassData,
      recorded: Parameters<typeof connection.call>[0]['recorded'],
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted()
      const id = randomUUID()
      // Always receive registration, then close its service if its caller was cancelled.
      // Otherwise a cancelled registration could leave an unreachable worker session.
      await connection.call(
        { id, data, recorded },
        {
          transfer: recorded.flatMap((field) => [
            field.elements.buffer as ArrayBuffer,
            field.columns.buffer as ArrayBuffer,
          ]),
        },
      )
      const table = connectTable(port, id, data.labels.length)
      if (signal?.aborted) {
        table.close()
        signal.throwIfAborted()
      }
      return table
    },
    close: () => connection.close(),
  }
}
/** Static cases reuse one worker; recordings use their existing CSV worker. */
export class TableWorker {
  private worker?: Worker
  private opener?: ReturnType<typeof tableOpener>
  async open(data: ClassData, signal?: AbortSignal) {
    if (!this.worker) {
      this.worker = new Worker(join(__dirname, 'table/worker.cjs'))
      this.opener = tableOpener(workerPort(this.worker))
    }
    return this.opener!.open(data, [], signal)
  }
  close() {
    this.opener?.close()
    this.opener = undefined
    void this.worker?.terminate()
    this.worker = undefined
  }
}
