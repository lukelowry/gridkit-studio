/** What says a results file is the one Studio read, whatever was done to it since. */

import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'

/** A file as it stands: which file it is, how large, and when it, or what is said of it, last
 *  changed. A file replaced, written over in place, or written again with its time set back
 *  differs in one of them: no tool sets the second time back. */
export interface Stamp {
  /** The volume and the file's own number on it. */
  readonly file: string
  readonly size: number
  /** When its bytes last changed, and when anything of it did, in nanoseconds. */
  readonly modified: string
  readonly changed: string
}

/** The stamp of the file `stats` describe, as `stat` gives them with `bigint`. */
export const stampOf = (stats: BigIntStats): Stamp => ({
  file: `${stats.dev}:${stats.ino}`,
  size: Number(stats.size),
  modified: String(stats.mtimeNs),
  changed: String(stats.ctimeNs),
})

/** The stamp of the file at `path`; none while there is no file there. */
export async function stampAt(path: string): Promise<Stamp | undefined> {
  try {
    return stampOf(await stat(path, { bigint: true }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Whether `a` and `b` are both stamps of one file as it stood once. */
export const same = (a?: Stamp, b?: Stamp): boolean =>
  !!a &&
  !!b &&
  a.file === b.file &&
  a.size === b.size &&
  a.modified === b.modified &&
  a.changed === b.changed
