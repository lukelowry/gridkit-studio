import { serveFiles } from '../workspace.js'
import { readFile } from './files.js'

let parent: MessagePort | undefined
export function useParent(port: MessagePort) {
  parent = port
}

export class Worker {
  readonly #owner = crypto.randomUUID()
  #worker?: globalThis.Worker
  #url?: string
  #closed = false
  #ready = false
  #pending: unknown[] = []
  #ports = new Set<MessagePort>()
  #children = new Set<Worker>()
  #proxy?: MessagePort
  #termination?: Promise<number>
  #exited?: (code: number) => void
  #listeners = new Map<string, Set<(value: any) => void>>()
  constructor(script: string, options: { workerData?: unknown; execArgv?: string[] } = {}) {
    void this.#start(script, options.workerData).catch((error: unknown) => {
      if (!this.#closed) {
        this.#emit('error', error)
        void this.terminate(1)
      }
    })
  }
  async #start(script: string, data: unknown) {
    // The extension host owns every worker, so a lost parent cannot leave its solver running.
    if (parent) {
      const channel = new MessageChannel()
      this.#proxy = channel.port1
      this.#ports.add(channel.port1)
      channel.port1.onmessage = ({ data }) => {
        if (data.event === 'exit') this.#finish(data.value)
        else this.#emit(data.event, data.value)
      }
      parent.postMessage({ script, data, port: channel.port2 }, [channel.port2])
      return
    }
    const bytes = (await readFile(script)) as Uint8Array<ArrayBuffer>
    if (this.#closed) return
    this.#url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }))
    const worker = (this.#worker = new globalThis.Worker(this.#url))
    worker.onerror = (event) => {
      this.#emit('error', new Error(event.message))
      void this.terminate(1)
    }
    worker.onmessageerror = () => {
      this.#emit('error', new Error('Worker message could not be read.'))
      void this.terminate(1)
    }
    worker.onmessage = ({ data }) => {
      if (data.__ready) {
        this.#ready = true
        for (const message of this.#pending) worker.postMessage(message)
        this.#pending = []
      } else if (data.__exit !== undefined) void this.terminate(data.__exit)
      else this.#emit('message', data)
    }
    const files = new MessageChannel()
    const children = new MessageChannel()
    this.#ports.add(files.port1)
    this.#ports.add(children.port1)
    serveFiles(files.port1)
    children.port1.onmessage = ({
      data: { script, data, port },
    }: MessageEvent<{ script: string; data: unknown; port: MessagePort }>) => {
      if (this.#closed) {
        port.close()
        return
      }
      const child = new Worker(script, { workerData: data })
      this.#children.add(child)
      this.#ports.add(port)
      child.on('message', (value) => port.postMessage({ event: 'message', value }))
      child.on('error', (value) => port.postMessage({ event: 'error', value }))
      child.once('exit', (value) => {
        port.postMessage({ event: 'exit', value })
        port.close()
        this.#ports.delete(port)
        this.#children.delete(child)
      })
      port.onmessage = ({ data }) => {
        if (data.kind === 'terminate') void child.terminate()
        else child.postMessage(data.message)
      }
    }
    worker.postMessage({ data, files: files.port2, children: children.port2, owner: this.#owner }, [
      files.port2,
      children.port2,
    ])
  }
  #emit(name: string, value: unknown) {
    for (const hear of [...(this.#listeners.get(name) ?? [])]) hear(value)
  }
  on(name: string, hear: (value: any) => void) {
    let listeners = this.#listeners.get(name)
    if (!listeners) this.#listeners.set(name, (listeners = new Set()))
    listeners.add(hear)
    return this
  }
  once(name: string, hear: (value: any) => void) {
    const once = (value: unknown) => {
      this.#listeners.get(name)?.delete(once)
      hear(value)
    }
    return this.on(name, once)
  }
  postMessage(message: unknown) {
    if (this.#closed) throw new Error('The worker is closed.')
    if (this.#proxy) this.#proxy.postMessage({ kind: 'post', message })
    else if (this.#ready) this.#worker!.postMessage(message)
    else this.#pending.push(message)
  }
  terminate(code = 0): Promise<number> {
    return (this.#termination ??= this.#stop(code))
  }
  async #stop(code: number) {
    if (this.#closed) return code
    this.#closed = true
    if (this.#proxy) {
      const ended = new Promise<number>((resolve) => {
        this.#exited = resolve
      })
      this.#proxy.postMessage({ kind: 'terminate' })
      return ended
    }
    await Promise.all([...this.#children].map((child) => child.terminate()))
    this.#worker?.terminate()
    // Worker.terminate() has no completion promise. Its lifetime lock is released with its files.
    await navigator.locks.request('gridkit-owner:' + this.#owner, () => {})
    this.#finish(code)
    return code
  }
  #finish(code: number) {
    this.#closed = true
    for (const port of this.#ports) port.close()
    this.#ports.clear()
    if (this.#url) URL.revokeObjectURL(this.#url)
    this.#pending = []
    this.#emit('exit', code)
    this.#listeners.clear()
    this.#exited?.(code)
  }
}
