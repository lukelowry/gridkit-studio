import { createHash } from '../crypto.js'
import { basename, join } from './path.js'
export const browser = true
export const outputPath = (path: string) =>
  path.startsWith('opfs:')
    ? path
    : join(
        `opfs:/gridkit/outputs/${createHash('sha256').update(path).digest('hex')}`,
        basename(path),
      )
export const lockOutput = (path: string, signal: AbortSignal) =>
  new Promise<() => void>((resolve, reject) => {
    void navigator.locks
      .request(
        'gridkit-output:' + path,
        { signal },
        () => new Promise<void>((release) => resolve(release)),
      )
      .catch(reject)
  })
export const tmpdir = () => '/tmp'
export let owner: string = crypto.randomUUID()
export const caseless = false
export const memory = () => ({ heapUsed: 0, arrayBuffers: 0 })
export const onExit = (_callback: () => void) => {}
export const alive = async (id: string | number) => {
  const locks = await navigator.locks.query()
  return locks.held?.some((lock) => lock.name === `gridkit-owner:${id}`) ?? false
}
export async function own(id: string) {
  owner = id
  await new Promise<void>((ready, reject) => {
    void navigator.locks
      .request(`gridkit-owner:${owner}`, async () => {
        ready()
        await new Promise(() => {})
      })
      .catch(reject)
  })
}
