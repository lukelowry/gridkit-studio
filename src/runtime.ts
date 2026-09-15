import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, relative, resolve, win32 } from 'node:path'

import type { SolverLaunch } from './launch.js'

export const GRIDKIT_IMAGE = 'ghcr.io/lukelowry/gridkit:latest'
export type SolverStream = 'stdout' | 'stderr'
export interface SimulationOptions {
  method: 'auto' | 'installed' | 'docker' | 'podman'
  executable: string
}
export interface SimulationCommand {
  executable: string
  args: string[]
  cwd: string
  stopArgs?: string[]
}
export interface Execution {
  done: Promise<number>
  cancel(): Promise<void>
}
export class SimulationConfigurationError extends Error {}

async function findExecutable(path: string): Promise<string | undefined> {
  const paths =
    process.platform === 'win32' && !extname(path) ? [path + '.exe', path + '.com'] : [path]
  for (const candidate of paths) {
    if (process.platform === 'win32' && !/\.(exe|com)$/i.test(candidate)) continue
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch (error) {
      if (
        !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
    }
  }
}
async function resolveExecutable(options: SimulationOptions, root: string) {
  const methods = ['installed', 'docker', 'podman'] as const
  if (
    !options ||
    !['auto', ...methods].includes(options.method) ||
    typeof options.executable !== 'string' ||
    options.executable.includes('\0')
  )
    throw new SimulationConfigurationError(
      'Check Simulation Method and DynamicSimulation Path in Settings.',
    )
  const choices = options.method === 'auto' ? methods : [options.method]
  const key =
    process.platform === 'win32'
      ? Object.keys(process.env).find((key) => key.toLowerCase() === 'path')
      : 'PATH'
  const directories = (key ? (process.env[key] ?? '') : '')
    .split(delimiter)
    .map((path) => (process.platform === 'win32' ? path.replace(/^"(.*)"$/, '$1') : path))
    .filter(isAbsolute)
  for (const method of choices) {
    if (method === 'installed' && options.executable) {
      const path = await findExecutable(resolve(root, options.executable))
      if (path) return { method, path }
      throw new SimulationConfigurationError(
        `DynamicSimulation executable is missing or not executable: ${resolve(root, options.executable)}`,
      )
    }
    const name = method === 'installed' ? 'DynamicSimulation' : method
    for (const directory of directories) {
      const path = await findExecutable(resolve(directory, name))
      if (path) return { method, path }
    }
  }
  throw new SimulationConfigurationError(
    options.method === 'auto'
      ? 'Install DynamicSimulation, Docker, or Podman, or set DynamicSimulation Path in Settings.'
      : `${options.method === 'installed' ? 'DynamicSimulation' : options.method} was not found on PATH. Check Simulation Method and DynamicSimulation Path in Settings.`,
  )
}
function containerArgs(launch: SolverLaunch, engine: 'docker' | 'podman', name: string): string[] {
  if (launch.root.includes(','))
    throw new Error(
      'Container execution does not support commas in the workspace path. Use installed DynamicSimulation or move the case folder.',
    )
  const fileNames = [
    launch.input.system_model_file,
    launch.input.output_file,
    launch.input.reference_file,
    ...(launch.raw.monitors ?? []).map((sink) => sink.file_name),
  ].filter((path): path is string => !!path)
  if (
    process.platform === 'win32' &&
    fileNames.some((path) => win32.isAbsolute(path) || path.includes('\\'))
  )
    throw new Error(
      'Use relative paths with forward slashes in solver and monitor files when running the Linux container from Windows.',
    )
  const root = process.platform === 'win32' ? '/workspace' : launch.root
  const mounted = (path: string) => `${root}/${relative(launch.root, path).split('\\').join('/')}`
  const permissions =
    engine === 'podman'
      ? ['--userns=keep-id']
      : process.platform !== 'win32' && process.getuid && process.getgid
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : []
  const label = engine === 'podman' ? ',relabel=shared' : ''
  return [
    'run',
    '--rm',
    '--pull=always',
    '--name',
    name,
    '--mount',
    `type=bind,source=${launch.root},target=${root}${label}`,
    '--workdir',
    mounted(launch.cwd),
    ...permissions,
    GRIDKIT_IMAGE,
    'DynamicSimulation',
    mounted(launch.solver),
  ]
}
export async function simulationCommand(
  launch: SolverLaunch,
  options: SimulationOptions,
): Promise<SimulationCommand> {
  const selected = await resolveExecutable(options, launch.root)
  if (selected.method === 'installed')
    return { executable: selected.path, args: [launch.solver], cwd: launch.cwd }
  const name = `gridkit-studio-${randomUUID()}`
  return {
    executable: selected.path,
    args: containerArgs(launch, selected.method, name),
    cwd: launch.cwd,
    stopArgs: ['rm', '-f', name],
  }
}

export function executeSolver(
  command: SimulationCommand,
  write: (stream: SolverStream, text: string) => void,
): Execution {
  write(
    'stdout',
    `${command.executable}\r\n${command.stopArgs ? GRIDKIT_IMAGE + '\r\n' : ''}${command.args.at(-1)}\r\n`,
  )
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (text: string) => write('stdout', text))
  child.stderr.on('data', (text: string) => write('stderr', text))
  let ended = false
  let cancelling: Promise<void> | undefined
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', (error) => {
      ended = true
      reject(new Error(`Cannot start ${command.executable}: ${error.message}`))
    })
    child.once('close', (code) => {
      ended = true
      resolve(code ?? 1)
    })
  })
  const removeContainer = () =>
    new Promise<void>((resolve) => {
      const remove = spawn(command.executable, command.stopArgs!, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let details = ''
      let finished = false
      remove.stderr.setEncoding('utf8')
      remove.stderr.on('data', (text: string) => {
        details += text
      })
      const finish = (message?: string) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (message) write('stderr', `Container cleanup: ${message}\r\n`)
        resolve()
      }
      const timer = setTimeout(() => {
        remove.kill('SIGKILL')
        finish('The container engine did not finish removing the simulation container.')
      }, 5000)
      remove.once('error', (error) => finish(error.message))
      remove.once('close', (code) =>
        finish(
          code && !/no such container|does not exist/i.test(details)
            ? details.trim() || `Container removal exited with code ${code}.`
            : undefined,
        ),
      )
    })
  const cancel = async () => {
    if (ended) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (!ended) child.kill('SIGKILL')
    }, 3000)
    try {
      await exit.catch(() => undefined)
      if (command.stopArgs) await removeContainer()
    } finally {
      clearTimeout(timer)
    }
  }
  const done = exit.finally(() => cancelling)
  return { done, cancel: () => (cancelling ??= cancel()) }
}
