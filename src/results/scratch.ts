/** Where runs keep their files: a folder per data worker under one root, which every VS Code window
 *  on this machine shares. A folder is named for the extension host that made it, so a window can
 *  tell its own from those of windows still open, and delete those no window still uses. */

import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** A folder of the old layout, a run straight under the root, is left this long to any window of
 *  an older Studio that may still be writing it. */
const LEGACY_MS = 24 * 60 * 60 * 1000

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

/** Delete the folders under `root` that no worker uses: those of extension hosts that have exited,
 *  and those of this one's earlier workers, which stop before another starts. `own` is kept. A
 *  folder that cannot be deleted yet is left for the next sweep. */
export async function sweep(root: string, own: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (!entry.isDirectory() || path === own) return
      const owner = /^(\d+)-[0-9a-f]{8}$/.exec(entry.name)
      if (owner) {
        const pid = Number(owner[1])
        if (pid !== process.pid && alive(pid)) return
      } else if (entry.name.startsWith('run-')) {
        const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Date.now() }))
        if (Date.now() - mtimeMs < LEGACY_MS) return
      } else return
      await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }),
  )
}
