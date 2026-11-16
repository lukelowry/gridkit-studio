import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GridKit } from '../shared/simulation.js'
import { launch, PROGRAM, recordRun, runtimeOf, sweepOrphans } from './runtime.js'

const exe = (name: string) => (process.platform === 'win32' ? name + '.exe' : name)
/** Empty installation selects the bundled solver. */
const settings = (named: Partial<GridKit>): GridKit => ({
  program: PROGRAM,
  path: '',
  ...named,
})

describe('where GridKit runs', () => {
  let root: string
  let path: string | undefined
  /** Creates an empty executable named `name` in `folder`. */
  async function program(folder: string, name: string): Promise<string> {
    await mkdir(folder, { recursive: true })
    const file = join(folder, exe(name))
    await writeFile(file, '')
    await chmod(file, 0o755)
    return file
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gridkit-runtime-'))
    path = process.env.PATH
    process.env.PATH = join(root, 'path')
  })
  afterEach(async () => {
    process.env.PATH = path
    await rm(root, { recursive: true, force: true })
  })

  it('runs the install its path names, before any other', async () => {
    const installed = await program(join(root, 'opt', 'bin'), 'DynamicSimulation')
    await program(join(root, 'path'), 'DynamicSimulation')
    await program(join(root, 'path'), 'docker')
    expect(await runtimeOf(settings({ path: join(root, 'opt') }))).toEqual({
      kind: 'installed',
      program: PROGRAM,
      path: installed,
    })
  })

  it('runs the program GridKit Path names', async () => {
    const simulation = await program(join(root, 'opt', 'bin'), 'DynamicSimulation')
    expect(await runtimeOf(settings({ path: simulation }))).toEqual({
      kind: 'installed',
      program: exe(PROGRAM),
      path: simulation,
    })
  })

  it('reports an invalid installation without falling back to WASM', async () => {
    await program(join(root, 'path'), 'docker')
    await expect(runtimeOf(settings({ path: join(root, 'missing') }))).rejects.toThrow(
      /GridKit Path/,
    )
  })

  it('uses WASM even when native GridKit and a container engine are on PATH', async () => {
    await program(join(root, 'path'), 'DynamicSimulation')
    await program(join(root, 'path'), 'docker')
    expect(await runtimeOf(settings({}))).toEqual({ kind: 'wasm', program: PROGRAM })
  })
  it('uses an explicitly named executable even when its basename differs', async () => {
    const named = await program(join(root, 'opt'), 'CustomSolver')
    expect(await runtimeOf(settings({ path: named }))).toMatchObject({
      kind: 'installed',
      path: named,
    })
  })
  it('uses a custom program only under an explicit installation', async () => {
    const named = await program(join(root, 'opt', 'bin'), 'Simulate')
    expect(
      await runtimeOf(settings({ path: join(root, 'opt'), program: 'Simulate' })),
    ).toMatchObject({ path: named })
    expect(await runtimeOf(settings({ program: 'Simulate' }))).toEqual({
      kind: 'wasm',
      program: PROGRAM,
    })
    await expect(
      runtimeOf(settings({ path: join(root, 'opt'), program: '../Simulate' })),
    ).rejects.toThrow('executable name')
  })
})

describe('runs a window that died left running', () => {
  let folder: string
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'gridkit-runs-'))
  })
  afterEach(() => rm(folder, { recursive: true, force: true }))

  /** A long-running process in its own group, like a GridKit run. */
  const runner = () =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
  /** The pid of a process that has exited, standing in for a closed window. */
  async function exited(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await once(child, 'exit')
    return child.pid!
  }
  const running = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('removes a record whose process identity no longer matches, without killing anything', async () => {
    const other = runner()
    try {
      const host = await exited()
      await writeFile(
        join(folder, `${host}-${other.pid}.json`),
        JSON.stringify({ host, pid: other.pid, identity: 'a process the system since gave away' }),
      )
      await sweepOrphans(folder)
      expect(running(other.pid!)).toBe(true)
      expect(await readdir(folder)).toEqual([])
    } finally {
      other.kill()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'ends the runs of windows that exited, and leaves those of windows still open',
    async () => {
      const orphan = runner()
      const gone = once(orphan, 'exit')
      try {
        const removeRecord = await recordRun(folder, orphan.pid!)
        // This window is still open, so its runs are left alone.
        await sweepOrphans(folder)
        expect(running(orphan.pid!)).toBe(true)
        const [name] = await readdir(folder)
        expect(name).toBeDefined()
        const record = JSON.parse(await readFile(join(folder, name!), 'utf8')) as object
        // The same run, recorded by a window that has exited.
        await writeFile(join(folder, name!), JSON.stringify({ ...record, host: await exited() }))
        await sweepOrphans(folder)
        await gone
        expect(await readdir(folder)).toEqual([])
        await removeRecord()
      } finally {
        orphan.kill()
      }
    },
  )
})

describe('how a run ends', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gridkit-launch-'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  /** Runs `script` as the solver file, with Node standing in for GridKit. */
  async function ends(script: string): Promise<void> {
    const solver = join(root, 'run.cjs')
    await writeFile(solver, script)
    const runtime = { kind: 'installed', program: PROGRAM, path: process.execPath } as const
    const log = () => {}
    return launch(runtime, solver, { signal: AbortSignal.any([]), log }).done
  }

  it('fails only on a nonzero exit, with the error GridKit printed on its line or the next', async () => {
    // GridKit prints errors it recovers from.
    await expect(ends(`console.log('[ERROR] Bus parameter "x" has no value.')`)).resolves.toBe(
      undefined,
    )
    await expect(
      ends(`console.log('[ERROR] ')
console.log('\tInvalid device class: "BusFault".')
process.exitCode = 1`),
    ).rejects.toThrow('Invalid device class: "BusFault".')
    await expect(ends('process.exitCode = 3')).rejects.toThrow(`${PROGRAM} exited with code 3.`)
  })
})
