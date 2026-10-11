import { type ResultsFile, unavailable } from '../results/index.js'

/** How many results files stay read before the oldest no one needs are let go. */
const KEPT = 8

/** The results files read for each case, the one it shows first. Past KEPT, the oldest that no view
 *  reads, no case shows and no run writes are let go. Their files stay. */
export class Shelf {
  readonly #cases = new Map<string, ResultsFile[]>()

  /** The results `id` names; once they are let go, a `results-unavailable` error. */
  find(id: string): ResultsFile {
    for (const files of this.#cases.values()) {
      const file = files.find((file) => file.info.id === id)
      if (file) return file
    }
    throw unavailable()
  }

  /** The results read whole from `path` for the case `uri` with content `fingerprint`, unchanged
   *  since `started`, made the ones the case shows; undefined when none are read. */
  reopen(uri: string, path: string, fingerprint: string, started: number): ResultsFile | undefined {
    const files = this.#cases.get(uri) ?? []
    const file = files.find(
      ({ info }) =>
        info.path === path &&
        info.fingerprint === fingerprint &&
        info.started === started &&
        !info.growing &&
        !info.error,
    )
    if (file) this.#cases.set(uri, [file, ...files.filter((other) => other !== file)])
    return file
  }

  /** Keeps `file` as the shown results of the case it was read for. */
  keep(file: ResultsFile): void {
    const { uri } = file.info.revision
    this.#cases.set(uri, [file, ...(this.#cases.get(uri) ?? [])])
    const all = [...this.#cases.values()].flat().sort((a, b) => a.info.started - b.info.started)
    for (const old of all.slice(0, Math.max(0, all.length - KEPT))) {
      const files = this.#cases.get(old.info.revision.uri)!
      if (old === files[0] || old.info.growing || old.busy) continue
      files.splice(files.indexOf(old), 1)
      void old.retire()
    }
  }

  /** Lets go of every results file read for the case `uri`, once whoever reads them stops. */
  async clear(uri: string): Promise<void> {
    const files = this.#cases.get(uri) ?? []
    this.#cases.delete(uri)
    await Promise.all(files.map((file) => file.retire()))
  }

  /** How many results files are read. */
  get size(): number {
    let size = 0
    for (const files of this.#cases.values()) size += files.length
    return size
  }
}
