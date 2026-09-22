/** Bounded LRU with shared builds. Cancelling one reader never cancels another. */
export class SharedCache<T> {
  private readonly entries = new Map<
    string,
    {
      controller: AbortController
      promise: Promise<T>
      users: number
      bytes: number
      done: boolean
    }
  >()
  constructor(
    private readonly budget: number,
    private readonly weigh: (value: T) => number,
    private readonly limit = 8,
  ) {}
  get(key: string, build: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    let entry = this.entries.get(key)
    if (!entry) {
      const controller = new AbortController()
      entry = { controller, users: 0, bytes: 0, done: false, promise: undefined! }
      const current = entry
      entry.promise = Promise.resolve()
        .then(() => build(controller.signal))
        .then(
          (value) => {
            controller.signal.throwIfAborted()
            current.done = true
            current.bytes = this.weigh(value)
            this.trim()
            return value
          },
          (error) => {
            if (this.entries.get(key) === current) this.entries.delete(key)
            throw error
          },
        )
      this.entries.set(key, entry)
    } else {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    const current = entry
    current.users++
    return new Promise<T>((resolve, reject) => {
      let ended = false
      const finish = () => {
        if (ended) return false
        ended = true
        signal?.removeEventListener('abort', abort)
        current.users--
        if (!current.done && !current.users) {
          current.controller.abort()
          if (this.entries.get(key) === current) this.entries.delete(key)
        }
        this.trim()
        return true
      }
      const abort = () => {
        if (finish()) reject(signal!.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      current.promise.then(
        (value) => {
          if (finish()) resolve(value)
        },
        (error) => {
          if (finish()) reject(error)
        },
      )
    })
  }
  private trim() {
    let bytes = 0
    for (const entry of this.entries.values()) bytes += entry.bytes
    for (const [key, entry] of this.entries) {
      if (bytes <= this.budget && this.entries.size <= this.limit) break
      if (!entry.done || entry.users) continue
      this.entries.delete(key)
      bytes -= entry.bytes
    }
  }
  deleteWhere(matches: (key: string) => boolean) {
    for (const [key, entry] of this.entries)
      if (matches(key)) {
        entry.controller.abort()
        this.entries.delete(key)
      }
  }
  clear() {
    for (const entry of this.entries.values()) entry.controller.abort()
    this.entries.clear()
  }
}
