import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GridKit } from '../shared/simulation.js'
import { launch, PROGRAM, runtimeOf, sweepOrphans, writeDown } from './runtime.js'

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
  /** A program named `name` in `folder`, which only has to exist and be executable. */
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

  /** A process that runs until it is ended, in a group of its own, as GridKit runs. */
  const runner = () =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
  /** The id of a window that has exited. */
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

  it('crosses out a run it cannot tell is the process written down, ending nothing', async () => {
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
        const crossOut = await writeDown(folder, orphan.pid!)
        // This window is open, and ends its own runs.
        await sweepOrphans(folder)
        expect(running(orphan.pid!)).toBe(true)
        const [name] = await readdir(folder)
        expect(name).toBeDefined()
        const written = JSON.parse(await readFile(join(folder, name!), 'utf8')) as object
        // The same run, written down by a window since exited.
        await writeFile(join(folder, name!), JSON.stringify({ ...written, host: await exited() }))
        await sweepOrphans(folder)
        await gone
        expect(await readdir(folder)).toEqual([])
        await crossOut()
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

  /** How a GridKit that does what `script` does ends: Node runs in its place, the script as its
   *  solver file. */
  async function ends(script: string): Promise<void> {
    const solver = join(root, 'run.cjs')
    await writeFile(solver, script)
    const runtime = { kind: 'installed', program: PROGRAM, path: process.execPath } as const
    const log = () => {}
    return launch(runtime, solver, { signal: AbortSignal.any([]), log }).done
  }

  it('fails only as GridKit exits, saying the error it printed, on its line or the next', async () => {
    // GridKit prints errors it goes on from.
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
