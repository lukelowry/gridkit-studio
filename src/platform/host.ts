import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { alive as running } from '../shared/processes.js'
import { createHash } from './crypto.js'
import { basename } from './path.js'
export { tmpdir }

export const browser = false
export const outputPath = (path: string) =>
  /^[a-z][\w+.-]+:/i.test(path)
    ? join(
        tmpdir(),
        'gridkit-studio-outputs',
        createHash('sha256').update(path).digest('hex'),
        basename(path),
      )
    : path
export const lockOutput = async (_path: string, _signal: AbortSignal) => () => {}
export const owner = String(process.pid)
export const caseless = process.platform === 'win32' || process.platform === 'darwin'
export const alive = (id: string | number) => running(Number(id))
export const memory = () => {
  const { heapUsed, arrayBuffers } = process.memoryUsage()
  return { heapUsed, arrayBuffers }
}
export const onExit = (callback: () => void) => process.once('exit', callback)
