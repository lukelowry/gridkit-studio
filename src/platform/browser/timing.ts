export function setTimeout<T>(
  delay: number,
  value?: T,
  options?: { signal?: AbortSignal },
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }, delay)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
const channel = new MessageChannel()
const pending: (() => void)[] = []
channel.port1.onmessage = () => pending.shift()?.()
export const setImmediate = () =>
  new Promise<void>((resolve) => {
    pending.push(resolve)
    channel.port2.postMessage(0)
  })
