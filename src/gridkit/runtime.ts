/** Runs DynamicSimulation where GridKit is installed or in a container, and stops all it started. */

import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'

import { message } from '../shared/format.js'
import type { GridKit, RuntimeProcess } from '../shared/messages.js'

const PROGRAM = 'DynamicSimulation'
/** Where a container sees the run's folder. */
const MOUNT = '/simulation'

/** How a run starts DynamicSimulation: the program installed here, or a container of `image`. */
export type Runtime =
  | { readonly kind: 'installed'; readonly program: string }
  | {
      readonly kind: 'container'
      readonly cli: string
      readonly podman: boolean
      readonly image: string
    }

const executable = (name: string) => (process.platform === 'win32' ? name + '.exe' : name)

/** Whether `path` is a file this process may execute. */
async function runs(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The program `name` on PATH, if it is there. */
async function onPath(name: string): Promise<string | undefined> {
  const folders = (process.env.PATH ?? process.env.Path ?? '')
    .split(delimiter)
    .map((folder) => folder.replace(/^"|"$/g, ''))
    .filter(isAbsolute)
  for (const folder of folders)
    if (await runs(join(folder, executable(name)))) return join(folder, executable(name))
  return undefined
}

const engines = new Map<string, Promise<boolean>>()
/** Whether `cli` is Podman, under its own name or, as podman-docker installs it, Docker's. */
function isPodman(cli: string): Promise<boolean> {
  if (/^podman/i.test(basename(cli))) return Promise.resolve(true)
  let podman = engines.get(cli)
  if (!podman)
    engines.set(
      cli,
      (podman = new Promise((resolve) => {
        // A CLI that cannot say what it is runs as Docker, and says why when it runs.
        try {
          execFile(cli, ['--version'], { windowsHide: true, timeout: 10_000 }, (_, stdout) =>
            resolve(/podman/i.test(stdout ?? '')),
          )
        } catch {
          resolve(false)
        }
      })),
    )
  return podman
}

/** The container CLI `cli` names; with none named, docker on PATH, else podman. */
async function containerCli(cli: string): Promise<string> {
  const found = cli
    ? isAbsolute(cli)
      ? (await runs(cli)) && cli
      : await onPath(cli)
    : ((await onPath('docker')) ?? (await onPath('podman')))
  if (found) return found
  throw new Error(
    cli
      ? `${cli} was not found. Check GridKit Studio: Container CLI.`
      : 'GridKit is not installed here, and GridKit Image runs in Docker or Podman. Install one, set GridKit Studio: GridKit Path to an install, or open this folder in a dev container with GridKit.',
  )
}

/** Where `gridkit` runs DynamicSimulation: the install its path names; else the one on PATH, as a
 *  dev container or remote host with GridKit has it; else a container of its image. */
export async function runtimeOf({ path, image, cli }: GridKit): Promise<Runtime> {
  if (path) {
    for (const program of [
      join(path, 'bin', executable(PROGRAM)),
      join(path, executable(PROGRAM)),
      path,
    ])
      if (await runs(program)) return { kind: 'installed', program }
    throw new Error(
      `GridKit's DynamicSimulation was not found under ${path}. Check GridKit Studio: GridKit Path.`,
    )
  }
  const program = await onPath(PROGRAM)
  if (program) return { kind: 'installed', program }
  if (image) {
    const found = await containerCli(cli)
    return { kind: 'container', cli: found, podman: await isPodman(found), image }
  }
  throw new Error(
    'GridKit is not installed here. Set GridKit Studio: GridKit Image to run it in Docker or Podman, set GridKit Path to its install folder, or open this folder in a dev container with GridKit.',
  )
}

/** Refuses an image that is not on this machine: the user pulls images, never Studio. */
async function requireImage(cli: string, podman: boolean, image: string): Promise<void> {
  const failed = await new Promise<string | null>((resolve) => {
    try {
      execFile(
        cli,
        ['image', 'inspect', '--format', '{{.Id}}', image],
        { windowsHide: true, timeout: 30_000 },
        (error, _, stderr) => resolve(error ? stderr.trim() || error.message : null),
      )
    } catch (error) {
      resolve(message(error))
    }
  })
  if (failed === null) return
  const engine = podman ? 'podman' : 'docker'
  throw new Error(
    /no such (image|object)|image not known|not found/i.test(failed)
      ? `${image} is not on this machine, and GridKit Studio never pulls images. Pull it yourself with \`${engine} pull ${image}\`, then run again.`
      : `${engine} could not find ${image}: ${failed}`,
  )
}

/** Where `gridkit` runs DynamicSimulation now: an install, or a container whose image is here. */
export async function available(gridkit: GridKit): Promise<Runtime> {
  const runtime = await runtimeOf(gridkit)
  if (runtime.kind === 'container') await requireImage(runtime.cli, runtime.podman, runtime.image)
  return runtime
}

/** The container CLI's arguments that run DynamicSimulation in `image` on the run in `directory`:
 *  a container named `name`, removed when it ends, with no network, from the local image only. */
export function containerArgs(
  image: string,
  directory: string,
  name: string,
  host: {
    readonly platform: NodeJS.Platform
    readonly podman: boolean
    readonly uid?: number
    readonly gid?: number
  },
): string[] {
  const linux = host.platform === 'linux'
  return [
    'run',
    '--rm',
    '--pull',
    'never',
    '--name',
    name,
    '--network',
    'none',
    // SELinux hosts let the container write the folder only once it is labeled for it.
    '--volume',
    `${directory}:${MOUNT}${linux ? ':Z' : ''}`,
    '--workdir',
    MOUNT,
    // What the run writes stays the user's own, to read and delete. Docker Desktop and Podman
    // machines on Windows and macOS map ownership themselves.
    ...(linux
      ? host.podman
        ? ['--userns', 'keep-id']
        : ['--user', `${host.uid ?? 0}:${host.gid ?? 0}`]
      : []),
    '--env',
    'OMP_NUM_THREADS=1',
    '--env',
    'OPENBLAS_NUM_THREADS=1',
    image,
    PROGRAM,
    'input.json',
  ]
}

/** Stops `child` and every process it started. */
function stopProcess(child: ChildProcess, owned: RuntimeProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return terminateRuntime(owned).catch(() => {
    child.kill('SIGKILL')
  })
}

/** Runs DynamicSimulation on the `input.json` staged in `directory`, as `gridkit` says. `log` hears
 *  each line it prints, and `lifecycle` the process while it lives. Aborting `signal` stops it. */
export async function launch(
  gridkit: GridKit,
  directory: string,
  signal: AbortSignal,
  log: (text: string) => void,
  lifecycle: (process?: RuntimeProcess) => void = () => {},
) {
  const runtime = await available(gridkit)
  signal.throwIfAborted()
  const container =
    runtime.kind === 'container'
      ? { cli: runtime.cli, name: 'gridkit-studio-' + randomUUID() }
      : undefined
  const [program, args] =
    runtime.kind === 'installed'
      ? [runtime.program, ['input.json']]
      : [
          runtime.cli,
          // A relative source would name a volume, not the folder.
          containerArgs(runtime.image, resolve(directory), container!.name, {
            platform: process.platform,
            podman: runtime.podman,
            uid: process.getuid?.(),
            gid: process.getgid?.(),
          }),
        ]
  if (runtime.kind === 'container')
    log(`Running GridKit from ${runtime.image} with ${runtime.podman ? 'Podman' : 'Docker'}.`)
  const child = spawn(program, args, {
    cwd: directory,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OMP_NUM_THREADS: '1',
      OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS ?? '1',
    },
  })
  const owned: RuntimeProcess = {
    pid: child.pid ?? 0,
    executable: program,
    ...(container && { container }),
  }
  if (child.pid) lifecycle(owned)
  let ended = false
  const tail: string[] = []
  let nativeError: string | undefined
  let cleanup: Promise<void> | undefined
  const stop = () => (cleanup ??= stopProcess(child, owned))
  const onAbort = () => {
    void stop()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  for (const pipe of [child.stdout, child.stderr])
    createInterface({ input: pipe, crlfDelay: Infinity }).on('line', (line) => {
      const text = stripVTControlCharacters(line).slice(0, 8192)
      tail.push(text)
      if (tail.length > 64) tail.shift()
      if (/\[ERROR\]/i.test(text)) nativeError ??= text
      log(text)
    })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      ended = true
      // A container that never ran says why last: no engine, no image, no access.
      const said = container ? tail.findLast((line) => line.trim()) : undefined
      if (signal.aborted) reject(signal.reason)
      else if (nativeError) reject(new Error(nativeError))
      else if (code !== 0)
        reject(new Error(`DynamicSimulation exited with code ${code}.${said ? ' ' + said : ''}`))
      else resolve()
    })
  }).finally(async () => {
    ended = true
    signal.removeEventListener('abort', onAbort)
    await cleanup
    try {
      await writeFile(join(directory, 'solver.log'), tail.join('\n') + '\n')
    } finally {
      lifecycle()
    }
  })
  void done.catch(() => {})
  return { done, stop, ended: () => ended }
}

/** Stops the process `owned` names and every process it started, and removes its container. The
 *  extension also calls it, should the data worker exit before cleaning up. */
export async function terminateRuntime(owned: RuntimeProcess): Promise<void> {
  // Ending the CLI leaves its container running: the engine removes it by name.
  if (owned.container)
    await new Promise<void>((resolve) =>
      execFile(
        owned.container!.cli,
        ['rm', '--force', owned.container!.name],
        { windowsHide: true, timeout: 30_000 },
        () => resolve(),
      ),
    )
  if (!owned.pid) return
  if (process.platform === 'win32')
    await new Promise<void>((resolve) => {
      const child = spawn(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(owned.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      )
      child.once('error', () => resolve())
      child.once('close', () => resolve())
    })
  else {
    try {
      process.kill(-owned.pid, 'SIGKILL')
    } catch {
      /* Already exited. */
    }
  }
}
