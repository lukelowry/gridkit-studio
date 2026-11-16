/** Native GridKit on the workspace host, with explicit installation selection. */
import { type ChildProcess, type ChildProcessByStdio, execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'

import type { GridKit, RuntimeProcess } from '../shared/messages.js'
import { alive } from '../shared/processes.js'
import { readSolverLine, type SolverLine } from './solver.js'
export const PROGRAM = 'DynamicSimulation'
const ASK_MS = 10_000
export type Runtime =
  | { readonly kind: 'wasm'; readonly program: string }
  | { readonly kind: 'installed'; readonly program: string; readonly path: string }
/** Whether a run can outlive a window that dies mid-run: only outside Windows, in its own group. */
const outlives = process.platform !== 'win32'

/** Identifies process `pid` by its start time and command line. Undefined once it has exited. */
async function identityOf(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux')
    try {
      const [status, command] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/cmdline`, 'utf8'),
      ])
      // The start time, in clock ticks since boot, is field 22. Field 2, the name in parentheses,
      // may contain spaces and parentheses.
      const start = status.slice(status.lastIndexOf(')') + 2).split(' ')[19]
      return start && `${start} ${command}`
    } catch {
      return undefined
    }
  return new Promise((resolve) =>
    execFile(
      'ps',
      ['-o', 'lstart=,command=', '-p', String(pid)],
      { windowsHide: true, timeout: ASK_MS },
      (error, stdout) => resolve((!error && stdout.trim()) || undefined),
    ),
  )
}

interface RunRecord {
  readonly host: number
  readonly pid: number
  readonly identity: string
}

/** Records in `folder` that this window started process `pid`, and returns its remover. */
export async function recordRun(folder: string, pid: number): Promise<() => Promise<void>> {
  const identity = await identityOf(pid)
  if (!identity) return async () => {}
  await mkdir(folder, { recursive: true })
  const path = join(folder, `${process.pid}-${pid}.json`)
  await writeFile(path, JSON.stringify({ host: process.pid, pid, identity } satisfies RunRecord))
  return () => rm(path, { force: true }).catch(() => {})
}

/** Kills the runs recorded in `folder` by windows that have exited, and removes their records. A
 *  process is killed only while its identity still matches, so a reused pid is never touched. */
export async function sweepOrphans(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [])
  await Promise.all(
    names.map(async (name) => {
      const path = join(folder, name)
      try {
        const { host, pid, identity } = JSON.parse(await readFile(path, 'utf8')) as RunRecord
        // A window that is still open stops its own runs.
        if (alive(host)) return
        if ((await identityOf(pid)) === identity) process.kill(-pid, 'SIGKILL')
      } catch {
        // Unreadable, or already gone.
      }
      await rm(path, { force: true }).catch(() => {})
    }),
  )
}

async function executableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}
export async function runtimeOf({ program, path }: GridKit): Promise<Runtime> {
  if (!path.trim()) return { kind: 'wasm', program: PROGRAM }
  if (!isAbsolute(path))
    throw new Error('GridKit Path must be resolved against the workspace before execution.')
  const info = await stat(path).catch(() => undefined)
  if (info?.isFile() && (await executableFile(path)))
    return { kind: 'installed', program: basename(path), path }
  if (!info?.isDirectory())
    throw new Error(`GridKit Path is not an executable or install directory: ${path}`)
  if (program === '.' || program === '..' || /[\\/:]/.test(program))
    throw new Error('GridKit Program must be an executable name.')
  const name = process.platform === 'win32' && !extname(program) ? program + '.exe' : program
  for (const found of [join(path, 'bin', name), join(path, name)])
    if (await executableFile(found)) return { kind: 'installed', program, path: found }
  throw new Error(`${program} was not found under ${path}. Check GridKit Studio: GridKit Path.`)
}
export async function available(gridkit: GridKit, signal?: AbortSignal): Promise<Runtime> {
  signal?.throwIfAborted()
  const runtime = await runtimeOf(gridkit)
  signal?.throwIfAborted()
  return runtime
}
function threads(env: NodeJS.ProcessEnv) {
  return {
    OMP_NUM_THREADS: env.OMP_NUM_THREADS ?? '1',
    OPENBLAS_NUM_THREADS: env.OPENBLAS_NUM_THREADS ?? '1',
  }
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

/** Stops `child` and its descendants, then `child` alone if it is still running. */
async function stopProcess(child: ChildProcess, owned: RuntimeProcess): Promise<void> {
  if (!child.pid || exited(child)) return
  await terminateRuntime(owned).catch(() => {})
  if (!exited(child)) child.kill('SIGKILL')
}

export interface Launch {
  readonly signal: AbortSignal
  readonly log: (text: string) => void
  /** Called with the process when it starts, and with nothing when it ends. */
  readonly lifecycle?: (process?: RuntimeProcess) => void
  /** The folder where windows record runs that may outlive them. */
  readonly runs?: string
}

/** Runs the executable on `solver`, in the solver file's folder. */
export function launch(
  runtime: Extract<Runtime, { kind: 'installed' }>,
  solver: string,
  { signal, log, lifecycle = () => {}, runs }: Launch,
) {
  signal.throwIfAborted()
  const folder = dirname(solver)
  const command = runtime.path
  const args = [basename(solver)]
  /** The error for a program that exists but did not start, such as a broken install. */
  const unstarted = (error: NodeJS.ErrnoException) =>
    new Error(
      `${basename(command)} did not start (${error.code ?? error.message}). Check GridKit Studio: GridKit Path.`,
      { cause: error },
    )
  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    child = spawn(command, args, {
      cwd: folder,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...threads(process.env) },
    })
  } catch (error) {
    throw unstarted(error as NodeJS.ErrnoException)
  }
  const owned: RuntimeProcess = {
    pid: child.pid ?? 0,
    executable: command,
  }
  if (child.pid) lifecycle(owned)
  // A native process group may outlive this window.
  const recorded =
    child.pid && runs && outlives
      ? recordRun(runs, child.pid).catch(() => async () => {})
      : undefined
  let writer: 'writing' | 'done' | 'stopped' = 'writing'
  /** The first error GridKit printed, from its line or the next. GridKit also prints errors it
   *  recovers from, so only the exit code decides failure. */
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
      if (!nativeError) {
        if (/\[ERROR\]/i.test(text)) nativeError = readSolverLine(text)
      } else if (!nativeError.text && text.trim())
        // GridKit often prints the message on the line after [ERROR]: "\n\tInvalid device class".
        nativeError = { level: 'error', text: text.trim() }
      log(text)
    })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error: NodeJS.ErrnoException) =>
      reject(child.pid === undefined ? unstarted(error) : error),
    )
    child.once('close', (code) => {
      writer = code === 0 && !signal.aborted ? 'done' : 'stopped'
      if (signal.aborted) reject(signal.reason)
      else if (code !== 0)
        reject(new Error(nativeError?.text || `${runtime.program} exited with code ${code}.`))
      else resolve()
    })
  }).finally(async () => {
    if (writer === 'writing') writer = 'stopped'
    signal.removeEventListener('abort', onAbort)
    await cleanup
    await (
      await recorded
    )?.()
    lifecycle()
  })
  void done.catch(() => {})
  return { done, stop, writer: () => writer }
}

/** Kills process `owned` and its descendants. The extension also calls it if the worker dies. */
export async function terminateRuntime(owned: RuntimeProcess): Promise<void> {
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
