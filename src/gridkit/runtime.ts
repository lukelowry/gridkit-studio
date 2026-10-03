import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'

import type { RuntimeOptions, RuntimeProcess } from '../messages.js'

async function executable(name: string): Promise<string | undefined> {
  const paths = isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? process.env.Path ?? '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((p) => join(p.replace(/^"|"$/g, ''), name))
  for (const path of paths)
    for (const candidate of process.platform === 'win32' && !/\.(exe|com)$/i.test(path)
      ? [path + '.exe', path + '.com']
      : [path]) {
      try {
        if ((await stat(candidate)).isFile()) {
          await access(candidate, constants.X_OK)
          return candidate
        }
      } catch {
        /* next PATH entry */
      }
    }
}
export async function resolveRuntime(options: RuntimeOptions, root: string) {
  const methods =
    options.method === 'auto' ? (['installed', 'docker', 'podman'] as const) : [options.method]
  for (const method of methods) {
    const path = await executable(
      method === 'installed'
        ? options.executable
          ? resolve(root, options.executable)
          : 'DynamicSimulation'
        : method,
    )
    if (path) return { method, path }
    if (method === 'installed' && options.executable)
      throw new Error('Configured DynamicSimulation executable was not found.')
  }
  throw new Error(
    'Install DynamicSimulation, Docker, or Podman, or set GridKit Studio: Dynamic Simulation Path.',
  )
}
function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform === 'win32')
    return new Promise((resolve) => {
      const task = spawn(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      )
      task.once('error', () => {
        child.kill()
        resolve()
      })
      task.once('close', () => resolve())
    })
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  return Promise.resolve()
}
export async function launch(
  options: RuntimeOptions,
  directory: string,
  signal: AbortSignal,
  log: (text: string) => void,
  lifecycle: (process?: RuntimeProcess) => void = () => {},
) {
  const runtime = await resolveRuntime(options, directory)
  signal.throwIfAborted()
  const name = 'gridkit-' + crypto.randomUUID()
  const container = runtime.method !== 'installed'
  if (container && directory.includes(','))
    throw new Error('Container mount paths cannot contain commas.')
  const args = container
    ? [
        'run',
        '--rm',
        '--name',
        name,
        '--mount',
        `type=bind,source=${directory},target=/work`,
        '--workdir',
        '/work',
        ...(runtime.method === 'podman'
          ? ['--userns=keep-id']
          : process.platform !== 'win32' && process.getuid
            ? ['--user', `${process.getuid()}:${process.getgid!()}`]
            : []),
        options.image,
        'DynamicSimulation',
        'input.json',
      ]
    : ['input.json']
  const child = spawn(runtime.path, args, {
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
  if (child.pid)
    lifecycle({
      pid: child.pid,
      executable: runtime.path,
      ...(container ? { container: name } : {}),
    })
  let ended = false
  let cleanup: Promise<void> | undefined
  const stop = () =>
    (cleanup ??= (async () => {
      if (container)
        await new Promise<void>((resolve) => {
          const command = spawn(runtime.path, ['rm', '--force', name], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 15000,
          })
          command.once('error', () => resolve())
          command.once('close', () => resolve())
        })
      await stopProcess(child)
    })())
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

/** Emergency owner cleanup if the data worker exits before its normal finally block. */
export async function terminateRuntime(owned: RuntimeProcess): Promise<void> {
  if (owned.container)
    await new Promise<void>((resolve) => {
      const child = spawn(owned.executable, ['rm', '--force', owned.container!], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 15000,
      })
      child.once('error', () => resolve())
      child.once('close', () => resolve())
    })
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
