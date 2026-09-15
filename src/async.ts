/** Starting a read aborts its predecessor. */
export class Latest {
  private controller = new AbortController()
  get signal(): AbortSignal {
    return this.controller.signal
  }
  next(): AbortSignal {
    this.controller.abort()
    this.controller = new AbortController()
    return this.controller.signal
  }
  abort(): void {
    this.controller.abort()
  }
}

/** Serialize calls and coalesce overlaps into one pending rerun. */
export function coalesce(run: () => Promise<void>): () => void {
  let busy = false
  let again = false
  const go = async () => {
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      do {
        again = false
        await run()
      } while (again)
    } finally {
      busy = false
    }
  }
  return () => void go()
}
