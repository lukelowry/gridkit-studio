import { parentPort, workerData } from 'node:worker_threads'

import { connectFiles } from './workspace.js'
if (workerData?.__files) connectFiles(workerData.__files)
export { workerData }
export const port = parentPort!
export const ready = () => {}
export const finish = () => {
  workerData?.__files?.close()
  parentPort!.close()
}
