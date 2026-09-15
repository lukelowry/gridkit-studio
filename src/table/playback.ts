/** Finish valid work, then consume the newest frame. Query/binding changes close the queue. */
export class FrameQueue<T> {
  private latest?: { value: T }
  private running = false
  private readonly controller = new AbortController()
  constructor(
    private readonly run: (value: T, signal: AbortSignal) => Promise<void>,
    private readonly failed: (error: unknown) => void,
  ) {}
  request(value: T) {
    if (this.controller.signal.aborted) return
    this.latest = { value }
    if (!this.running) void this.drain()
  }
  private async drain() {
    this.running = true
    while (this.latest && !this.controller.signal.aborted) {
      const { value } = this.latest
      this.latest = undefined
      try {
        await this.run(value, this.controller.signal)
      } catch (error) {
        if (!this.controller.signal.aborted) this.failed(error)
      }
    }
    this.running = false
  }
  close() {
    this.latest = undefined
    this.controller.abort()
  }
}
