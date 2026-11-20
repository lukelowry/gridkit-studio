export interface WorkspaceApi {
  read: { input: { path: string }; output: Uint8Array }
  stat: {
    input: { path: string }
    output: { size: number; mtime: number; ctime: number; type: number }
  }
  write: { input: { path: string; bytes: Uint8Array }; output: null }
  mkdir: { input: { path: string }; output: null }
  rename: { input: { from: string; to: string }; output: null }
  remove: { input: { path: string; recursive?: boolean; force?: boolean }; output: null }
  list: { input: { path: string }; output: [string, number][] }
}
import { answerer, Caller, type Cancel, type Reply, type Request } from '../shared/rpc.js'
import { transferables } from '../workers/transfer.js'

type Call = <K extends keyof WorkspaceApi>(
  method: K,
  input: WorkspaceApi[K]['input'],
  signal?: AbortSignal,
) => Promise<WorkspaceApi[K]['output']>
let call: Call = async () => {
  throw new Error('Workspace access is unavailable.')
}
export const workspaceCall: Call = (method, input, signal) => call(method, input, signal)
export function useWorkspace(handler: Call) {
  call = handler
}
export interface WorkspacePort {
  postMessage(value: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<Reply | Request | Cancel>) => void) | null
  start(): void
}
export function connectFiles(port: WorkspacePort) {
  const caller = new Caller<WorkspaceApi>((message) => port.postMessage(message))
  port.onmessage = ({ data }) => caller.settle(data as Reply)
  port.start()
  useWorkspace((method, input, signal) => caller.call(method, input, signal))
}
export function serveFiles(port: WorkspacePort) {
  const server = answerer<WorkspaceApi>(
    {
      read: (input, signal) => workspaceCall('read', input, signal),
      stat: (input, signal) => workspaceCall('stat', input, signal),
      write: (input, signal) => workspaceCall('write', input, signal),
      mkdir: (input, signal) => workspaceCall('mkdir', input, signal),
      rename: (input, signal) => workspaceCall('rename', input, signal),
      remove: (input, signal) => workspaceCall('remove', input, signal),
      list: (input, signal) => workspaceCall('list', input, signal),
    },
    (reply, transfer = []) => port.postMessage(reply, [...transfer]),
    (_method, value) => transferables(value),
  )
  port.onmessage = ({ data }) => server.receive(data as Request | Cancel)
  port.start()
}
