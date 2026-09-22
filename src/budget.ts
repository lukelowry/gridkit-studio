export class ByteBudget {
  private used = 0
  private pending: {
    bytes: number
    signal?: AbortSignal
    resolve(release: () => void): void
    reject(error: unknown): void
    detach(): void
  }[] = []
  constructor(
    readonly capacity: number,
    private readonly queueLimit = 128,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError('Invalid memory budget.')
  }
  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.capacity)
      return Promise.reject(new RangeError('Request exceeds the memory budget.'))
    if (this.pending.length >= this.queueLimit)
      return Promise.reject(new Error('Too many pending reads. Retry after current reads finish.'))
    return new Promise((resolve, reject) => {
      const job = {
        bytes,
        signal,
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', abort),
      }
      const abort = () => {
        const at = this.pending.indexOf(job)
        if (at >= 0) {
          this.pending.splice(at, 1)
          job.detach()
          reject(signal!.reason)
          this.drain()
        }
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.push(job)
      this.drain()
    })
  }
  private drain() {
    while (this.pending.length && this.pending[0].bytes <= this.capacity - this.used) {
      const job = this.pending.shift()!
      job.detach()
      this.used += job.bytes
      let released = false
      job.resolve(() => {
        if (!released) {
          released = true
          this.used -= job.bytes
          this.drain()
        }
      })
    }
  }
}
export const sampleBudget = new ByteBudget(128 * 1024 * 1024)
