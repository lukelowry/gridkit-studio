import { connectFiles } from '../workspace.js'
import { own } from './host.js'
import { useParent } from './thread.js'

const scope = self as DedicatedWorkerGlobalScope
const initial = await new Promise<{
  data: unknown
  files: MessagePort
  children: MessagePort
  owner: string
}>((resolve) => {
  scope.addEventListener('message', (event) => resolve(event.data), { once: true })
})
connectFiles(initial.files)
useParent(initial.children)
await own(initial.owner)
export const workerData = initial.data
export const port = {
  postMessage: (message: unknown, transfer: readonly ArrayBuffer[] = []) =>
    scope.postMessage(message, [...transfer]),
  on: (_name: 'message', listener: (value: any) => void) =>
    scope.addEventListener('message', ({ data }) => listener(data)),
}
export const ready = () => scope.postMessage({ __ready: true })
export const finish = () => {
  scope.postMessage({ __exit: 0 })
  scope.close()
}
