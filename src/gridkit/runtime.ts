/** Runs GridKit's programs where GridKit is installed or in a container, and stops all it started. */

import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'

import { message } from '../shared/format.js'
import type { GridKit, Program, RuntimeProcess } from '../shared/messages.js'
/** Where a container sees the run's folder. */
const MOUNT = '/simulation'
/** The label that names the machine a run's container was started from. */
const MACHINE = 'gridkit-studio.machine=' + hostname()

/** Whether process `pid` is running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // It runs, as another user's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A run's container name: the extension host that started it, then a part of its own. */
const containerName = () => `gridkit-studio-${process.pid}-${randomUUID().slice(0, 8)}`

/** Of the container `names`, those whose extension host has exited. */
export function abandoned(names: readonly string[]): string[] {
  return names.filter((name) => {
    const pid = Number(/^gridkit-studio-(\d+)-/.exec(name.trim())?.[1])
    return pid > 0 && !alive(pid)
  })
}

const swept = new Map<string, Promise<void>>()
/** Remove the containers this machine's closed windows left running: a window that closes mid-run
 *  may not live to remove its own. Once per container CLI. */
function sweepContainers(cli: string): Promise<void> {
  let sweep = swept.get(cli)
  if (!sweep)
    swept.set(
      cli,
      (sweep = new Promise((resolve) =>
        execFile(
          cli,
          ['ps', '--all', '--filter', 'label=' + MACHINE, '--format', '{{.Names}}'],
          { windowsHide: true, timeout: 10_000 },
          (error, stdout) => {
            const left = error ? [] : abandoned(stdout.split(/\r?\n/))
            if (!left.length) return resolve()
            execFile(
              cli,
              ['rm', '--force', ...left.map((name) => name.trim())],
              { windowsHide: true, timeout: 30_000 },
              () => resolve(),
            )
          },
        ),
      )),
    )
  return sweep
}

/** How a run starts a GridKit program: installed here, or in a container of `image`. */
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

/** Where `gridkit` runs `program`: the install its path names, or beside the program it names;
 *  else the one on PATH, as a dev container or remote host with GridKit has it; else a container
 *  of its image. */
export async function runtimeOf(
  { path, image, cli }: GridKit,
  program: Program = 'DynamicSimulation',
): Promise<Runtime> {
  const name = executable(program)
  if (path) {
    for (const found of [
      join(path, 'bin', name),
      join(path, name),
      ...((await runs(path)) ? [join(dirname(path), name)] : []),
    ])
      if (await runs(found)) return { kind: 'installed', program: found }
    throw new Error(
      `GridKit's ${program} was not found under ${path}. Check GridKit Studio: GridKit Path.`,
    )
  }
  const found = await onPath(program)
  if (found) return { kind: 'installed', program: found }
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

/** Where `gridkit` runs `program` now: an install, or a container whose image is here. */
export async function available(
  gridkit: GridKit,
  program: Program = 'DynamicSimulation',
): Promise<Runtime> {
  const runtime = await runtimeOf(gridkit, program)
  if (runtime.kind === 'container') await requireImage(runtime.cli, runtime.podman, runtime.image)
  return runtime
}

/** The container CLI's arguments that run `program` in `image` on the run in `directory`: a
 *  container named `name` and labelled with this machine, removed when it ends, with no network,
 *  from the local image only. */
export function containerArgs(
  program: Program,
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
    '--label',
    MACHINE,
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
    program,
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

/** Runs `program` on the `input.json` staged in `directory`, as `gridkit` says. `log` hears each
 *  line it prints, and `lifecycle` the process while it lives. Aborting `signal` stops it. A
 *  ContingencyAnalysis contingency that fails is not the run's failure: `failed` names it. */
export async function launch(
  gridkit: GridKit,
  program: Program,
  directory: string,
  signal: AbortSignal,
  log: (text: string) => void,
  lifecycle: (process?: RuntimeProcess) => void = () => {},
) {
  const runtime = await available(gridkit, program)
  signal.throwIfAborted()
  const container =
    runtime.kind === 'container' ? { cli: runtime.cli, name: containerName() } : undefined
  // Not awaited: a slow engine never delays the run, and this host's runs are never removed.
  if (container) void sweepContainers(container.cli)
  const [command, args] =
    runtime.kind === 'installed'
      ? [runtime.program, ['input.json']]
      : [
          runtime.cli,
          // A relative source would name a volume, not the folder.
          containerArgs(program, runtime.image, resolve(directory), container!.name, {
            platform: process.platform,
            podman: runtime.podman,
            uid: process.getuid?.(),
            gid: process.getgid?.(),
          }),
        ]
  if (runtime.kind === 'container')
    log(`Running GridKit from ${runtime.image} with ${runtime.podman ? 'Podman' : 'Docker'}.`)
  const child = spawn(command, args, {
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
    executable: command,
    ...(container && { container }),
  }
  if (child.pid) lifecycle(owned)
  let ended = false
  const tail: string[] = []
  let nativeError: string | undefined
  /** The faults whose contingencies failed, by ID. */
  const failed = new Set<string>()
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
      const study = /Study failed for fault: (\S+)/.exec(text)
      if (study) failed.add(study[1]!)
      // A contingency's solver errors are its own, not the run's.
      else if (/\[ERROR\]/i.test(text) && (program === 'DynamicSimulation' || /failed:/.test(text)))
        nativeError ??= text
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
      // ContingencyAnalysis exits 1 when a contingency failed; the study still finished.
      else if (code !== 0 && !(program === 'ContingencyAnalysis' && failed.size))
        reject(new Error(`${program} exited with code ${code}.${said ? ' ' + said : ''}`))
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
  return { done, stop, ended: () => ended, failed: (): ReadonlySet<string> => failed, runtime }
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
