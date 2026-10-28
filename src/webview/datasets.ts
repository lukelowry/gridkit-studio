import { Data } from 'latkit'

export interface DatasetVersion {
  readonly key: string
  readonly data: Data
}

/** Publish complete revisions only. Views keep their previous native source until reassigned. */
export class DatasetSlot {
  #current?: DatasetVersion
  #pending?: Data
  #generation = 0

  get current(): DatasetVersion | undefined {
    return this.#current
  }

  async receive(
    name: string,
    key: string,
    patches: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    base?: string,
  ): Promise<boolean> {
    const generation = ++this.#generation
    this.#pending?.destroy()
    this.#pending = undefined
    signal.throwIfAborted()
    const candidate = new Data(name)
    this.#pending = candidate
    try {
      if (base !== undefined) {
        const current = this.#current
        if (!current || current.key !== base || current.data.name !== name) {
          throw new Error('The dataset update has a different base revision.')
        }
        using snapshot = current.data.snapshot()
        candidate.restore(snapshot)
      }
      for await (const bytes of patches) {
        signal.throwIfAborted()
        if (generation !== this.#generation) return false
        candidate.apply(bytes)
      }
      signal.throwIfAborted()
      if (generation !== this.#generation) return false
      const previous = this.#current
      this.#current = { key, data: candidate }
      this.#pending = undefined
      previous?.data.destroy()
      return true
    } finally {
      if (this.#current?.data !== candidate) candidate.destroy()
      if (this.#pending === candidate) this.#pending = undefined
    }
  }

  clear(): void {
    ++this.#generation
    this.#pending?.destroy()
    this.#current?.data.destroy()
    this.#pending = undefined
    this.#current = undefined
  }
}
