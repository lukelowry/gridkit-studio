/** Cancels and drains readers before their retained result files can be removed. */
export class Readers<T extends object> {
  readonly #active = new Map<T, Set<{ controller: AbortController; done: Promise<void> }>>()
  readonly #retired = new WeakSet<T>()

  async use<R>(
    values: readonly T[],
    signal: AbortSignal,
    read: (signal: AbortSignal) => Promise<R>,
  ): Promise<R> {
    signal.throwIfAborted()
    if (values.some((value) => this.#retired.has(value)))
      throw new Error('The run is no longer open.')
    const controller = new AbortController()
    let resolve!: () => void
    const lease = {
      controller,
      done: new Promise<void>((done) => {
        resolve = done
      }),
    }
    for (const value of new Set(values)) {
      const leases = this.#active.get(value) ?? new Set()
      leases.add(lease)
      this.#active.set(value, leases)
    }
    try {
      return await read(AbortSignal.any([signal, controller.signal]))
    } finally {
      for (const value of values) {
        const leases = this.#active.get(value)
        leases?.delete(lease)
        if (!leases?.size) this.#active.delete(value)
      }
      resolve()
    }
  }

  async retire(value: T) {
    this.#retired.add(value)
    const leases = [...(this.#active.get(value) ?? [])]
    for (const lease of leases)
      lease.controller.abort(new Error('The run was cleared or replaced.'))
    await Promise.all(leases.map((lease) => lease.done))
  }
}
