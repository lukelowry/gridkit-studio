import type { FrameRequest } from '../../shared/data.js'

/** What a plot's feed reads with, and tells. */
export interface FeedSource {
  /** Reads `request` at `version`, the frames recorded so far; true once the plot's data changed. */
  read(request: FrameRequest, version: number, signal: AbortSignal): Promise<boolean>
  /** Resolves once the plot's view has drawn what it holds; undefined while it has no view. */
  drawn(signal: AbortSignal): Promise<void> | undefined
  /** The frames recorded now, or none once the results are gone. */
  version(): number | undefined
  /** The plot's data changed. */
  received(): void
  /** A read failed. */
  failed(error: unknown): void
}

/** The samples a plot shows, read one window at a time. A read waits until the view has drawn what
 *  it holds, then reads every frame recorded by then, and reads again if more were recorded
 *  meanwhile. A run that records faster than the page draws is plotted as often as the page can
 *  draw it, never starved by reads started over at each new frame. Another window, or `stop`,
 *  lets go of the read under way at once. */
export class PlotFeed {
  #reading?: { key: string; controller: AbortController; again: boolean }

  constructor(private readonly source: FeedSource) {}

  /** Shows `request`'s window: read now, or again once the read under way of it ends. */
  want(request: FrameRequest): void {
    const key = JSON.stringify(request)
    if (this.#reading?.key === key) {
      this.#reading.again = true
      return
    }
    this.stop()
    const current = (this.#reading = { key, controller: new AbortController(), again: false })
    const { signal } = current.controller
    void (async () => {
      do {
        current.again = false
        // A view gone meanwhile has nothing left to draw.
        await this.source.drawn(signal)?.catch(() => signal.throwIfAborted())
        const version = this.source.version()
        if (!version) return
        if ((await this.source.read(request, version, signal)) && !signal.aborted)
          this.source.received()
      } while (current.again && !signal.aborted)
    })().then(
      () => {
        if (this.#reading === current) this.#reading = undefined
      },
      (error: unknown) => {
        if (this.#reading === current) this.#reading = undefined
        if (!signal.aborted) this.source.failed(error)
      },
    )
  }

  /** Lets go of the read under way. */
  stop(): void {
    this.#reading?.controller.abort()
    this.#reading = undefined
  }
}
