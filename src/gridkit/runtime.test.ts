import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GridKit } from '../shared/simulation.js'
import {
  abandoned,
  containerArgs,
  launch,
  PROGRAM,
  runtimeOf,
  sweepOrphans,
  writeDown,
} from './runtime.js'

const exe = (name: string) => (process.platform === 'win32' ? name + '.exe' : name)
/** GridKit as the settings name it, run as an image unless they say otherwise. */
const settings = (named: Partial<GridKit>): GridKit => ({
  program: PROGRAM,
  path: '',
  image: 'gridkit:latest',
  cli: '',
  ...named,
})

/** A solver file in a workspace's folder. */
const place = { root: '/work', solver: '/work/studies/IEEE39.solver.json' }

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
    expect(await runtimeOf(settings({ path: simulation, image: '' }))).toEqual({
      kind: 'installed',
      program: PROGRAM,
      path: simulation,
    })
  })

  it('refuses a path with no GridKit rather than falling back to the image', async () => {
    await program(join(root, 'path'), 'docker')
    await expect(runtimeOf(settings({ path: join(root, 'missing') }))).rejects.toThrow(
      /GridKit Path/,
    )
  })

  it('runs DynamicSimulation on PATH, as a dev container has it, before the image', async () => {
    const installed = await program(join(root, 'path'), 'DynamicSimulation')
    await program(join(root, 'path'), 'docker')
    expect(await runtimeOf(settings({}))).toEqual({
      kind: 'installed',
      program: PROGRAM,
      path: installed,
    })
  })

  it('runs the image where GridKit is not installed, in Docker, else Podman', async () => {
    const podman = await program(join(root, 'path'), 'podman')
    expect(await runtimeOf(settings({}))).toEqual({
      kind: 'container',
      program: PROGRAM,
      cli: podman,
      podman: true,
      image: 'gridkit:latest',
    })
    const docker = await program(join(root, 'path'), 'docker')
    expect(await runtimeOf(settings({}))).toMatchObject({
      cli: docker,
    })
    expect(await runtimeOf(settings({ cli: 'podman' }))).toMatchObject({
      cli: podman,
      podman: true,
    })
  })

  it('runs the program its settings name, installed or in the image', async () => {
    const named = await program(join(root, 'path'), 'Simulate')
    expect(await runtimeOf(settings({ program: 'Simulate' }))).toEqual({
      kind: 'installed',
      program: 'Simulate',
      path: named,
    })
    await program(join(root, 'opt', 'bin'), 'DynamicSimulation')
    await expect(
      runtimeOf(settings({ program: 'Simulate', path: join(root, 'opt') })),
    ).rejects.toThrow(/Simulate was not found/)
    expect(
      containerArgs({ image: 'gridkit:latest', program: 'Simulate' }, place, 'n', {
        platform: 'win32',
        podman: false,
      }).slice(-2),
    ).toEqual(['Simulate', 'IEEE39.solver.json'])
  })

  it('says how to run GridKit when it has nowhere to', async () => {
    await expect(runtimeOf(settings({ image: '' }))).rejects.toThrow(/GridKit Image/)
    await expect(runtimeOf(settings({}))).rejects.toThrow(/Docker or Podman/)
    await expect(runtimeOf(settings({ cli: 'nerdctl' }))).rejects.toThrow(/Container CLI/)
  })
})

describe('a container run', () => {
  const run = (platform: NodeJS.Platform, podman: boolean) =>
    containerArgs({ image: 'gridkit:latest', program: PROGRAM }, place, 'gridkit-studio-1', {
      platform,
      podman,
      uid: 1000,
      gid: 100,
    })

  it('leaves the containers of windows still open, and finds those of windows that closed', () => {
    expect(
      abandoned([
        `gridkit-studio-${process.pid}-0badf00d`,
        `gridkit-studio-${process.ppid}-12345678\r`,
        'gridkit-studio-2147483646-abcdef01',
        'someone-else',
        '',
      ]),
    ).toEqual(['gridkit-studio-2147483646-abcdef01'])
  })

  it('runs the solver file in its folder of the mounted workspace, never pulling, with no network', () => {
    const args = run('win32', false)
    expect(args.slice(0, 2)).toEqual(['run', '--rm'])
    expect(args.join(' ')).toContain(
      `--pull never --name gridkit-studio-1 --label gridkit-studio.machine=${hostname()} --network none`,
    )
    expect(args.join(' ')).toContain('--volume /work:/workspace --workdir /workspace/studies')
    expect(args.slice(-3)).toEqual(['gridkit:latest', 'DynamicSimulation', 'IEEE39.solver.json'])
    expect(
      containerArgs(
        { image: 'gridkit:latest', program: PROGRAM },
        { root: '/work', solver: '/work/IEEE39.solver.json' },
        'n',
        { platform: 'win32', podman: false },
      ),
    ).toEqual(expect.arrayContaining(['--workdir', '/workspace']))
    expect(args).not.toContain('--user')
  })

  it('leaves what a run writes readable by the user on Linux, for Docker and rootless Podman alike', () => {
    const docker = run('linux', false).join(' ')
    expect(docker).toContain('--user 1000:100')
    // The workspace is the user's, so its SELinux label is shared, not private to one container.
    expect(docker).toContain('/work:/workspace:z')
    const podman = run('linux', true).join(' ')
    expect(podman).toContain('--userns keep-id')
    expect(podman).not.toContain('--user ')
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
    return launch(runtime, { root, solver, touches: [] }, { signal: AbortSignal.any([]), log }).done
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
