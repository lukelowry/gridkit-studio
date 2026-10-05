import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { containerArgs, runtimeOf } from './runtime.js'

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
  const run = (platform: NodeJS.Platform, podman: boolean) =>
    containerArgs('gridkit:latest', '/runs/run-1', 'gridkit-studio-1', {
      platform,
      podman,
      uid: 1000,
      gid: 100,
    })

  it('runs DynamicSimulation on the run folder, never pulling, with no network', () => {
    const args = run('win32', false)
    expect(args.slice(0, 2)).toEqual(['run', '--rm'])
    expect(args.join(' ')).toContain('--pull never --name gridkit-studio-1 --network none')
    expect(args.join(' ')).toContain('--volume /runs/run-1:/simulation --workdir /simulation')
    expect(args.slice(-3)).toEqual(['gridkit:latest', 'DynamicSimulation', 'input.json'])
    expect(args).not.toContain('--user')
  })

  it('leaves what a run writes readable by the user on Linux, for Docker and rootless Podman alike', () => {
    const docker = run('linux', false).join(' ')
    expect(docker).toContain('--user 1000:100')
    expect(docker).toContain('/runs/run-1:/simulation:Z')
    const podman = run('linux', true).join(' ')
    expect(podman).toContain('--userns keep-id')
    expect(podman).not.toContain('--user ')
  })
})
