import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { abandoned, containerArgs, runtimeOf, sweepOrphans, writeDown } from './runtime.js'

const exe = (name: string) => (process.platform === 'win32' ? name + '.exe' : name)

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
    expect(await runtimeOf({ path: join(root, 'opt'), image: 'gridkit:latest', cli: '' })).toEqual({
      kind: 'installed',
      program: installed,
    })
  })

  it('runs the program GridKit Path names', async () => {
    const simulation = await program(join(root, 'opt', 'bin'), 'DynamicSimulation')
    const gridkit = { path: simulation, image: '', cli: '' }
    expect(await runtimeOf(gridkit)).toEqual({ kind: 'installed', program: simulation })
  })

  it('refuses a path with no GridKit rather than falling back to the image', async () => {
    await program(join(root, 'path'), 'docker')
    await expect(
      runtimeOf({ path: join(root, 'missing'), image: 'gridkit:latest', cli: '' }),
    ).rejects.toThrow(/GridKit Path/)
  })

  it('runs DynamicSimulation on PATH, as a dev container has it, before the image', async () => {
    const installed = await program(join(root, 'path'), 'DynamicSimulation')
    await program(join(root, 'path'), 'docker')
    expect(await runtimeOf({ path: '', image: 'gridkit:latest', cli: '' })).toEqual({
      kind: 'installed',
      program: installed,
    })
  })

  it('runs the image where GridKit is not installed, in Docker, else Podman', async () => {
    const podman = await program(join(root, 'path'), 'podman')
    expect(await runtimeOf({ path: '', image: 'gridkit:latest', cli: '' })).toEqual({
      kind: 'container',
      cli: podman,
      podman: true,
      image: 'gridkit:latest',
    })
    const docker = await program(join(root, 'path'), 'docker')
    expect(await runtimeOf({ path: '', image: 'gridkit:latest', cli: '' })).toMatchObject({
      cli: docker,
    })
    expect(await runtimeOf({ path: '', image: 'gridkit:latest', cli: 'podman' })).toMatchObject({
      cli: podman,
      podman: true,
    })
  })

  it('says how to run GridKit when it has nowhere to', async () => {
    await expect(runtimeOf({ path: '', image: '', cli: '' })).rejects.toThrow(/GridKit Image/)
    await expect(runtimeOf({ path: '', image: 'gridkit:latest', cli: '' })).rejects.toThrow(
      /Docker or Podman/,
    )
    await expect(runtimeOf({ path: '', image: 'gridkit:latest', cli: 'nerdctl' })).rejects.toThrow(
      /Container CLI/,
    )
  })
})

describe('a container run', () => {
  const place = { root: '/work', solver: '/work/studies/IEEE39.solver.json' }
  const run = (platform: NodeJS.Platform, podman: boolean) =>
    containerArgs('gridkit:latest', place, 'gridkit-studio-1', {
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
      containerArgs('gridkit:latest', { root: '/work', solver: '/work/IEEE39.solver.json' }, 'n', {
        platform: 'win32',
        podman: false,
      }),
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
