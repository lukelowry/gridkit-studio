/** Runs GridKit's DynamicSimulation where GridKit is installed or in a container, and stops all it
 *  started. */

import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import { createInterface } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'

import { message } from '../shared/errors.js'
import type { GridKit, RuntimeProcess } from '../shared/messages.js'
import { readSolverLine, type SolverLine } from './solver.js'

/** The GridKit program Studio runs on a solver file. */
export const PROGRAM = 'DynamicSimulation'
/** Where a container sees the workspace folder. */
const MOUNT = '/workspace'
/** How long a container CLI may take to list or describe what it holds, and to remove a container. */
const ASK_MS = 10_000
const REMOVE_MS = 30_000
/** How many of a run's last lines say why a container that never ran stopped. */
const TAIL_LINES = 64

/** Where a run happens: GridKit runs `solver` in its folder, as a shell would, and a container
 *  mounts `root`, which must hold every file the run `touches`. */
export interface Place {
  readonly root: string
  readonly solver: string
  readonly touches: readonly string[]
}
/** The label that names the machine a run's container was started from. */
const MACHINE = 'gridkit-studio.machine=' + hostname()

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
          { windowsHide: true, timeout: ASK_MS },
          (error, stdout) => {
            const left = error ? [] : abandoned(stdout.split(/\r?\n/))
            if (!left.length) return resolve()
            execFile(
              cli,
              ['rm', '--force', ...left.map((name) => name.trim())],
              { windowsHide: true, timeout: REMOVE_MS },
              () => resolve(),
            )
          },
        ),
      )),
    )
  return sweep
}

/** How a run starts GridKit: installed here, or in a container of `image`. */
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
          execFile(cli, ['--version'], { windowsHide: true, timeout: ASK_MS }, (_, stdout) =>
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
      : 'GridKit is not installed here, and GridKit Image needs Docker or Podman. Install one, or set GridKit Studio: GridKit Path to a GridKit install.',
  )
}

/** Where `gridkit` runs: the install its path names, or beside the program it names; else the one
 *  on PATH, as a dev container or remote host with GridKit has it; else a container of its image. */
export async function runtimeOf({ path, image, cli }: GridKit): Promise<Runtime> {
  const name = executable(PROGRAM)
  if (path) {
    for (const found of [
      join(path, 'bin', name),
      join(path, name),
      ...((await runs(path)) ? [join(dirname(path), name)] : []),
    ])
      if (await runs(found)) return { kind: 'installed', program: found }
    throw new Error(
      `GridKit's ${PROGRAM} was not found under ${path}. Check GridKit Studio: GridKit Path.`,
    )
  }
  const found = await onPath(PROGRAM)
  if (found) return { kind: 'installed', program: found }
  if (image) {
    const found = await containerCli(cli)
    return { kind: 'container', cli: found, podman: await isPodman(found), image }
  }
  throw new Error(
    'GridKit is not installed here. Set GridKit Studio: GridKit Path to its install folder, or GridKit Image to run it in Docker or Podman.',
  )
}

/** Refuses an image that is not on this machine: the user pulls images, never Studio. However long the
 *  engine takes to answer, as Docker Desktop starting cold does, the run waits, until `signal` stops it. */
async function requireImage(
  cli: string,
  podman: boolean,
  image: string,
  signal?: AbortSignal,
): Promise<void> {
  const failed = await new Promise<string | null>((resolve) => {
    try {
      execFile(
        cli,
        ['image', 'inspect', '--format', '{{.Id}}', image],
        { windowsHide: true, ...(signal && { signal }) },
        (error, _, stderr) => resolve(error ? stderr.trim() || error.message : null),
      )
    } catch (error) {
      resolve(message(error))
    }
  })
  signal?.throwIfAborted()
  if (failed === null) return
  const engine = podman ? 'podman' : 'docker'
  throw new Error(
    /no such (image|object)|image not known|not found/i.test(failed)
      ? `${image} is not on this machine, and GridKit Studio never pulls images. Pull it yourself with \`${engine} pull ${image}\`, then run again.`
      : `${engine} could not find ${image}: ${failed}`,
  )
}

/** Where `gridkit` runs now: an install, or a container whose image is here. */
export async function available(gridkit: GridKit, signal?: AbortSignal): Promise<Runtime> {
  const runtime = await runtimeOf(gridkit)
  if (runtime.kind === 'container')
    await requireImage(runtime.cli, runtime.podman, runtime.image, signal)
  return runtime
}

/** Where `gridkit` runs on the solver file `place` names, settled before a run touches anything: an
 *  install, or a container whose image is here and whose mount holds every file the run touches. */
export async function placed(gridkit: GridKit, place: Place, signal: AbortSignal) {
  const runtime = await available(gridkit, signal)
  signal.throwIfAborted()
  if (runtime.kind === 'container')
    for (const path of [place.solver, ...place.touches]) {
      const inside = relative(place.root, path)
      if (inside.startsWith('..') || isAbsolute(inside))
        throw new Error(
          `${basename(path)} is outside ${place.root}, the folder GridKit's container mounts.`,
        )
    }
  return runtime
}

/** How many threads GridKit's math libraries take: one each, unless the environment says. */
function threads(env: NodeJS.ProcessEnv) {
  return {
    OMP_NUM_THREADS: env.OMP_NUM_THREADS ?? '1',
    OPENBLAS_NUM_THREADS: env.OPENBLAS_NUM_THREADS ?? '1',
  }
}

/** The container CLI's arguments that run GridKit in `image` on the solver file `place` names: a
 *  container named `name` and labelled with this machine, removed when it ends, with no network,
 *  from the local image only. */
export function containerArgs(
  image: string,
  place: Pick<Place, 'root' | 'solver'>,
  name: string,
  host: {
    readonly platform: NodeJS.Platform
    readonly podman: boolean
    readonly uid?: number
    readonly gid?: number
    readonly env?: NodeJS.ProcessEnv
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
    // SELinux hosts let a container write a folder only once it is labeled for it. The workspace
    // is the user's, so its label is shared rather than private to one container.
    '--volume',
    `${place.root}:${MOUNT}${linux ? ':z' : ''}`,
    '--workdir',
    posix.join(MOUNT, ...relative(place.root, dirname(place.solver)).split(sep)),
    // What the run writes stays the user's own, to read and delete. Docker Desktop and Podman
    // machines on Windows and macOS map ownership themselves.
    ...(linux
      ? host.podman
        ? ['--userns', 'keep-id']
        : ['--user', `${host.uid ?? 0}:${host.gid ?? 0}`]
      : []),
    ...Object.entries(threads(host.env ?? {})).flatMap(([name, value]) => [
      '--env',
      `${name}=${value}`,
    ]),
    image,
    PROGRAM,
    basename(place.solver),
  ]
}

/** Stops `child` and every process it started. */
function stopProcess(child: ChildProcess, owned: RuntimeProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return terminateRuntime(owned).catch(() => {
    child.kill('SIGKILL')
  })
}

/** Runs GridKit with `runtime`, which `placed` settled, on the solver file `place` names, in its
 *  folder. `log` hears each line it prints, and `lifecycle` the process while it lives. Aborting
 *  `signal` stops it. */
export function launch(
  runtime: Runtime,
  place: Place,
  signal: AbortSignal,
  log: (text: string) => void,
  lifecycle: (process?: RuntimeProcess) => void = () => {},
) {
  signal.throwIfAborted()
  const folder = dirname(place.solver)
  const container =
    runtime.kind === 'container' ? { cli: runtime.cli, name: containerName() } : undefined
  // Not awaited: a slow engine never delays the run, and this host's runs are never removed.
  if (container) void sweepContainers(container.cli)
  const [command, args] =
    runtime.kind === 'installed'
      ? [runtime.program, [basename(place.solver)]]
      : [
          runtime.cli,
          // A relative source would name a volume, not the folder.
          containerArgs(
            runtime.image,
            { root: resolve(place.root), solver: resolve(place.solver) },
            container!.name,
            {
              platform: process.platform,
              podman: runtime.podman,
              uid: process.getuid?.(),
              gid: process.getgid?.(),
              env: process.env,
            },
          ),
        ]
  if (runtime.kind === 'container')
    log(`Running GridKit from ${runtime.image} with ${runtime.podman ? 'Podman' : 'Docker'}.`)
  const child = spawn(command, args, {
    cwd: folder,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...threads(process.env) },
  })
  const owned: RuntimeProcess = {
    pid: child.pid ?? 0,
    executable: command,
    ...(container && { container }),
  }
  if (child.pid) lifecycle(owned)
  let ended = false
  /** The last lines printed, which say why a container that never ran stopped. */
  const tail: string[] = []
  /** What stopped the run: the first error GridKit printed. */
  let nativeError: SolverLine | undefined
  let cleanup: Promise<void> | undefined
  const stop = () => (cleanup ??= stopProcess(child, owned))
  const onAbort = () => {
    void stop()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  for (const pipe of [child.stdout, child.stderr])
    createInterface({ input: pipe, crlfDelay: Infinity }).on('line', (line) => {
      const text = stripVTControlCharacters(line)
      tail.push(text)
      if (tail.length > TAIL_LINES) tail.shift()
      if (/\[ERROR\]/i.test(text)) nativeError ??= readSolverLine(text)
      log(text)
    })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      ended = true
      // A container that never ran says why last: no engine, no image, no access.
      const said = container ? tail.findLast((line) => line.trim()) : undefined
      if (signal.aborted) reject(signal.reason)
      else if (nativeError) reject(new Error(nativeError.text))
      else if (code !== 0)
        reject(new Error(`${PROGRAM} exited with code ${code}.${said ? ' ' + said : ''}`))
      else resolve()
    })
  }).finally(async () => {
    ended = true
    signal.removeEventListener('abort', onAbort)
    await cleanup
    // A run stopped while the engine still made its container leaves one the first removal missed;
    // with the CLI gone, nothing makes it any more.
    if (cleanup && container) await removeContainer(container)
    lifecycle()
  })
  void done.catch(() => {})
  return { done, stop, ended: () => ended }
}

/** Removes the container `cli` runs by `name`, whether it runs or not; one already gone is fine. */
const removeContainer = ({ cli, name }: { cli: string; name: string }) =>
  new Promise<void>((resolve) =>
    execFile(cli, ['rm', '--force', name], { windowsHide: true, timeout: REMOVE_MS }, () =>
      resolve(),
    ),
  )

/** Stops the process `owned` names and every process it started, and removes its container. The
 *  extension also calls it, should the results worker exit before cleaning up. */
export async function terminateRuntime(owned: RuntimeProcess): Promise<void> {
  // Ending the CLI leaves its container running: the engine removes it by name.
  if (owned.container) await removeContainer(owned.container)
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
