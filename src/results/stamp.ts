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

/** File times move in steps, as long as two seconds (FAT): a file written again within a step of
 *  its last change may keep its stamp. */
const STEP_NS = 2_000_000_000n

/** Whether `stamp`, taken at `at` (nanoseconds since 1970), tells every later write of its file:
 *  the file last changed a step or more before. */
export const settled = (stamp: Stamp, at: bigint): boolean =>
  at - BigInt(stamp.modified) >= STEP_NS && at - BigInt(stamp.changed) >= STEP_NS

/** Whether `a` and `b` are both stamps of one file as it stood once. */
export const same = (a?: Stamp, b?: Stamp): boolean =>
  !!a &&
  !!b &&
  a.file === b.file &&
  a.size === b.size &&
  a.modified === b.modified &&
  a.changed === b.changed
