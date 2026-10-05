import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { scratchFolder, sweep } from './scratch.js'

let root = ''
afterEach(() => rm(root, { recursive: true, force: true }))

describe('runs folders', () => {
  it("deletes what no worker uses, and keeps this worker's folder and other open windows'", async () => {
    root = await mkdtemp(join(tmpdir(), 'gridkit-scratch-test-'))
    const own = scratchFolder(root)
    // An earlier worker of this extension host, which has stopped.
    const earlier = join(root, `${process.pid}-0badf00d`)
    // A window still open: the process that started this one.
    const open = join(root, `${process.ppid}-12345678`)
    // A window that closed: no process has this id.
    const closed = join(root, '2147483646-abcdef01')
    // Anything else under the root is no worker's.
    const stray = join(root, 'run-1')
    for (const folder of [own, earlier, open, closed, stray])
      await mkdir(join(folder, 'run-1'), { recursive: true })
    await writeFile(join(root, 'stray.csv'), '')

    await sweep(root, own)

    expect((await readdir(root)).sort()).toEqual([basename(own), basename(open)].sort())
  })
  it('does nothing when no run was ever kept', async () => {
    root = join(tmpdir(), 'gridkit-scratch-missing')
    await expect(sweep(root, scratchFolder(root))).resolves.toBeUndefined()
  })
})
