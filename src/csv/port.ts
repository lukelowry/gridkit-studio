import type { MessagePort, Worker } from 'node:worker_threads'

import type { Port } from '@latkit/port'
export function workerPort(worker: Worker | MessagePort): Port {
  return {
    post: (message, transfer) => worker.postMessage(message, transfer ? [...transfer] : []),
    subscribe(receive, close) {
      const ended = () => close?.('CsvSource worker closed.')
      worker.on('message', receive)
      worker.on('error', ended)
      worker.on('exit', ended)
      worker.on('close', ended)
      return () => {
        worker.off('message', receive)
        worker.off('error', ended)
        worker.off('exit', ended)
        worker.off('close', ended)
      }
    },
  }
}
