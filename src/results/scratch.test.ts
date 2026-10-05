import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { scratchFolder, sweep } from './scratch.js'

let root = ''
afterEach(() => rm(root, { recursive: true, force: true }))

describe('runs folders', () => {
  it("deletes the folders no worker uses, and keeps this worker's and other open windows'", async () => {
    root = await mkdtemp(join(tmpdir(), 'gridkit-scratch-test-'))
    const own = scratchFolder(root)
    // An earlier worker of this extension host, which has stopped.
    const earlier = join(root, `${process.pid}-0badf00d`)
    // A window still open: the process that started this one.
    const open = join(root, `${process.ppid}-12345678`)
    // A window that closed: no process has this id.
    const closed = join(root, '2147483646-abcdef01')
    // Runs of the old layout, one recent and one a day old, and a folder Studio did not name.
    const recent = join(root, 'run-recent')
    const old = join(root, 'run-old')
    const other = join(root, 'notes')
    for (const folder of [own, earlier, open, closed, recent, old, other])
      await mkdir(join(folder, 'run-1'), { recursive: true })
    const day = (Date.now() - 25 * 60 * 60 * 1000) / 1000
    await utimes(old, day, day)

    await sweep(root, own)

    expect((await readdir(root)).sort()).toEqual(
      [basename(own), basename(open), 'notes', 'run-recent'].sort(),
    )
  })
  it('does nothing when no run was ever kept', async () => {
    root = join(tmpdir(), 'gridkit-scratch-missing')
    await expect(sweep(root, scratchFolder(root))).resolves.toBeUndefined()
  })
})
