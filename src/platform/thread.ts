import { MessageChannel, Worker as Thread, type WorkerOptions } from 'node:worker_threads'

import { serveFiles, type WorkspacePort } from './workspace.js'
export class Worker extends Thread {
  constructor(script: string, options: WorkerOptions = {}) {
    const files = new MessageChannel()
    super(script, {
      ...options,
      workerData: { ...options.workerData, __files: files.port2 },
      transferList: [...(options.transferList ?? []), files.port2],
    })
    serveFiles(files.port1 as unknown as WorkspacePort)
    this.once('exit', () => files.port1.close())
  }
}
