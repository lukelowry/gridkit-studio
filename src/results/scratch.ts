/** Where runs keep their files: a folder per data worker under one root, which every VS Code window
 *  on this machine shares. A folder is named for the extension host that made it, so a window can
 *  tell its own from those of windows still open, and delete what no window still uses. */

import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** A new worker's folder under `root`. */
export function scratchFolder(root: string): string {
  return join(root, `${process.pid}-${randomUUID().slice(0, 8)}`)
}

/** Whether process `pid` is running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // It runs, as another user's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Delete everything under `root` but `own` and the folders of other extension hosts still
 *  running. This host's other folders belong to its earlier workers, which stop before another
 *  starts. What cannot be deleted yet is left for the next sweep. */
export async function sweep(root: string, own: string): Promise<void> {
  const entries = await readdir(root).catch(() => [])
  await Promise.all(
    entries.map(async (name) => {
      const path = join(root, name)
      if (path === own) return
      const pid = Number(/^(\d+)-[0-9a-f]{8}$/.exec(name)?.[1])
      if (pid && pid !== process.pid && alive(pid)) return
      await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }),
  )
}
