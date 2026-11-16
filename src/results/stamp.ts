/** Identifies a results file as Studio read it, whatever was done to it since. */

import type { BigIntStats } from '../platform/files.js'
import { stat } from '../platform/files.js'

/** A replaced or rewritten file differs in at least one field, since no tool sets ctime back. */
export interface Stamp {
  readonly file: string
  readonly size: number
  /** mtime and ctime in nanoseconds. */
  readonly modified: string
  readonly changed: string
}

export const stampOf = (stats: BigIntStats): Stamp => ({
  file: `${stats.dev}:${stats.ino}`,
  size: Number(stats.size),
  modified: String(stats.mtimeNs),
  changed: String(stats.ctimeNs),
})

export async function stampAt(path: string): Promise<Stamp | undefined> {
  try {
    return stampOf(await stat(path, { bigint: true }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** File times have a resolution of up to two seconds (FAT), so a file rewritten within that time
 *  of its last change may keep its stamp. */
const STEP_NS = 2_000_000_000n

/** Whether `stamp`, taken at `at` (ns since 1970), will reveal every later write. */
export const settled = (stamp: Stamp, at: bigint): boolean =>
  at - BigInt(stamp.modified) >= STEP_NS && at - BigInt(stamp.changed) >= STEP_NS

export const same = (a?: Stamp, b?: Stamp): boolean =>
  !!a &&
  !!b &&
  a.file === b.file &&
  a.size === b.size &&
  a.modified === b.modified &&
  a.changed === b.changed
