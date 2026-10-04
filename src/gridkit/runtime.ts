/** Run GridKit's DynamicSimulation from where GridKit is installed, and stop it with all it started. */

import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'

import type { RuntimeProcess } from '../messages.js'

/** The simulation program, as a GridKit install names it. */
const PROGRAM = process.platform === 'win32' ? 'DynamicSimulation.exe' : 'DynamicSimulation'

async function runs(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The DynamicSimulation of the GridKit installed at `install` (its `bin`, the folder itself, or
 *  the program named outright), or with none given, the one on PATH. */
export async function dynamicSimulation(install: string): Promise<string> {
  const folders = install
    ? [join(install, 'bin'), install]
    : (process.env.PATH ?? process.env.Path ?? '')
        .split(delimiter)
        .map((folder) => folder.replace(/^"|"$/g, ''))
        .filter(isAbsolute)
  for (const folder of folders) if (await runs(join(folder, PROGRAM))) return join(folder, PROGRAM)
  if (install && (await runs(install))) return install
  throw new Error(
    install
      ? `GridKit's DynamicSimulation was not found under ${install}. Check GridKit Studio: GridKit Path.`
      : 'GridKit is not installed here. Set GridKit Studio: GridKit Path to its install folder, or open this folder where GridKit is installed, such as a dev container.',
  )
}

/** Stop `child` and every process it started. */
function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return terminateRuntime({ pid: child.pid, executable: child.spawnfile }).catch(() => {
    child.kill('SIGKILL')
  })
}

/** Run DynamicSimulation on the `input.json` staged in `directory`. `log` hears each line it
 *  prints, and `lifecycle` the process while it lives. Aborting `signal` stops it. */
export async function launch(
  install: string,
  directory: string,
  signal: AbortSignal,
  log: (text: string) => void,
  lifecycle: (process?: RuntimeProcess) => void = () => {},
) {
  const executable = await dynamicSimulation(install)
  signal.throwIfAborted()
  const child = spawn(executable, ['input.json'], {
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
  if (child.pid) lifecycle({ pid: child.pid, executable })
  let ended = false
  let cleanup: Promise<void> | undefined
  const stop = () => (cleanup ??= stopProcess(child))
  const onAbort = () => {
    void stop()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  for (const pipe of [child.stdout, child.stderr])
    createInterface({ input: pipe, crlfDelay: Infinity }).on('line', (line) =>
      log(stripVTControlCharacters(line).slice(0, 8192)),
    )
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      ended = true
      if (signal.aborted) reject(signal.reason)
      else if (code !== 0) reject(new Error(`DynamicSimulation exited with code ${code}.`))
      else resolve()
    })
  }).finally(async () => {
    ended = true
    signal.removeEventListener('abort', onAbort)
    await cleanup
    lifecycle()
  })
  void done.catch(() => {})
  return { done, stop, ended: () => ended }
}

/** Stop the process `owned` names and every process it started; also the owner's emergency
 *  cleanup, should the data worker exit before its own. */
export async function terminateRuntime(owned: RuntimeProcess): Promise<void> {
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
