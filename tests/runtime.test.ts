import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SolverOutput } from '../src/gridkit/output.js'
import type { SolverLaunch } from '../src/launch.js'
import { executeSolver, simulationCommand, SimulationConfigurationError } from '../src/runtime.js'

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof childProcess>()) }))

let root: string
const nativePlatform = process.platform
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'gridkit runtime '))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.doUnmock('node:path')
  vi.resetModules()
  await fs.rm(root, { recursive: true, force: true })
})
function launch(folder = root): SolverLaunch {
  return {
    root: folder,
    cwd: folder,
    solver: path.join(folder, 'network.solver.json'),
    input: { system_model_file: 'network.case.json' },
    raw: { monitors: [] },
  } as unknown as SolverLaunch
}
async function executable(name: string, directory = root) {
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, name + (nativePlatform === 'win32' ? '.exe' : ''))
  await fs.writeFile(file, '', { mode: 0o755 })
  return fs.realpath(file)
}
const auto = { method: 'auto', executable: '' } as const

it('prefers installed DynamicSimulation over container engines', async () => {
  const installed = await executable('DynamicSimulation')
  await executable('docker')
  await executable('podman')
  vi.stubEnv('PATH', root)
  expect(await simulationCommand(launch(), auto)).toEqual({
    executable: installed,
    args: [launch().solver],
    cwd: root,
    runtime: { method: 'installed', path: installed },
  })
})
it('uses Docker before Podman and honors explicit Podman selection', async () => {
  const docker = await executable('docker')
  const podman = await executable('podman')
  vi.stubEnv('PATH', root)
  expect((await simulationCommand(launch(), auto)).executable).toBe(docker)
  expect(
    (await simulationCommand(launch(), { method: 'podman', executable: '/unused' })).executable,
  ).toBe(podman)
  await fs.unlink(docker)
  expect((await simulationCommand(launch(), auto)).executable).toBe(podman)
})
it('resolves a developer build relative to the workspace, not the solver directory', async () => {
  const file = await executable('DynamicSimulation', path.join(root, 'build with spaces'))
  const source = { ...launch(), cwd: path.join(root, 'cases') }
  vi.stubEnv('PATH', '')
  expect(
    (await simulationCommand(source, { ...auto, executable: path.relative(root, file) }))
      .executable,
  ).toBe(file)
})
it('does not fall back when an explicitly selected executable or method is missing', async () => {
  await executable('docker')
  vi.stubEnv('PATH', root)
  await expect(
    simulationCommand(launch(), { ...auto, executable: 'missing' }),
  ).rejects.toBeInstanceOf(SimulationConfigurationError)
  await expect(
    simulationCommand(launch(), { method: 'installed', executable: '' }),
  ).rejects.toThrow('DynamicSimulation was not found')
})
it('rejects directories and malformed settings', async () => {
  await fs.mkdir(path.join(root, 'directory.exe'))
  await expect(
    simulationCommand(launch(), { ...auto, executable: 'directory.exe' }),
  ).rejects.toThrow('not executable')
  await expect(
    simulationCommand(launch(), { method: 'invalid', executable: '' } as never),
  ).rejects.toThrow('Settings')
  await expect(simulationCommand(launch(), { ...auto, executable: 2 } as never)).rejects.toThrow(
    'Settings',
  )
})
it('rejects invalid executable paths with a settings error', async () => {
  await expect(
    simulationCommand(launch(), { ...auto, executable: 'invalid\0path' }),
  ).rejects.toBeInstanceOf(SimulationConfigurationError)
})
it('does not search the working directory through empty or relative PATH entries', async () => {
  await executable('DynamicSimulation')
  vi.stubEnv('PATH', ['', '.', 'build'].join(path.delimiter))
  await expect(simulationCommand(launch(), auto)).rejects.toThrow('Install DynamicSimulation')
})
it.skipIf(nativePlatform === 'win32')('skips files without executable permission', async () => {
  const file = path.join(root, 'DynamicSimulation')
  await fs.writeFile(file, '', { mode: 0o644 })
  vi.stubEnv('PATH', root)
  await expect(simulationCommand(launch(), auto)).rejects.toThrow('Install DynamicSimulation')
})
it.skipIf(nativePlatform !== 'win32')(
  'accepts quoted PATH directories but never selects batch scripts',
  async () => {
    const file = await executable('DynamicSimulation')
    vi.stubEnv('PATH', `"${root}"`)
    expect((await simulationCommand(launch(), auto)).executable).toBe(file)
    await fs.unlink(file)
    await fs.writeFile(path.join(root, 'DynamicSimulation.cmd'), '@echo bad')
    await expect(simulationCommand(launch(), auto)).rejects.toThrow('Install DynamicSimulation')
  },
)
it('applies comma restrictions only to container execution', async () => {
  const file = await executable('DynamicSimulation')
  await executable('docker')
  vi.stubEnv('PATH', root)
  const source = launch(path.join(root, 'case, folder'))
  expect((await simulationCommand(source, { ...auto, executable: file })).executable).toBe(file)
  await expect(simulationCommand(source, { method: 'docker', executable: '' })).rejects.toThrow(
    'commas',
  )
})

async function platformRuntime(platform: 'win32' | 'linux' | 'darwin') {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const folder = platform === 'win32' ? 'C:\\cases' : '/cases'
  const tools = platform === 'win32' ? 'C:\\tools' : '/tools'
  vi.stubGlobal('process', {
    ...process,
    platform,
    env: { PATH: tools },
    getuid: () => 1001,
    getgid: () => 1002,
  })
  vi.doMock('node:path', () => ({ ...paths, win32: path.win32 }))
  vi.spyOn(fs, 'stat').mockImplementation(async (file) => {
    const allowed = ['docker', 'podman', 'DynamicSimulation'].map((name) =>
      paths.join(tools, name + (platform === 'win32' ? '.exe' : '')),
    )
    if (!allowed.includes(String(file)))
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return { isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>
  })
  vi.spyOn(fs, 'access').mockResolvedValue(undefined)
  vi.spyOn(fs, 'realpath').mockImplementation(async (file) => String(file))
  vi.resetModules()
  const runtime = await import('../src/runtime.js')
  const source = {
    ...launch(folder),
    cwd: paths.join(folder, 'nested case'),
    solver: paths.join(folder, 'nested case', 'network.solver.json'),
  }
  return { runtime, source }
}
describe.each(['win32', 'linux', 'darwin'] as const)('%s commands', (platform) => {
  it('preserves argument boundaries, uses the latest image, and removes only its own container', async () => {
    const { runtime, source } = await platformRuntime(platform)
    for (const method of ['docker', 'podman'] as const) {
      const command = await runtime.simulationCommand(source, { method, executable: '' })
      expect(command.args).toContain('--pull=always')
      expect(command.args.slice(-3)).toEqual([
        runtime.GRIDKIT_IMAGE,
        'DynamicSimulation',
        `${platform === 'win32' ? '/workspace' : '/cases'}/nested case/network.solver.json`,
      ])
      expect(command.args[command.args.indexOf('--workdir') + 1]).toBe(
        `${platform === 'win32' ? '/workspace' : '/cases'}/nested case`,
      )
      expect(command.stopArgs).toEqual([
        'rm',
        '-f',
        command.args[command.args.indexOf('--name') + 1],
      ])
      expect(command.cwd).toBe(source.cwd)
      if (method === 'podman') {
        expect(command.args).toContain('--userns=keep-id')
        expect(command.args).not.toContain('--user')
        expect(command.args[command.args.indexOf('--mount') + 1]).toContain('relabel=shared')
      } else {
        expect(command.args.includes('--user')).toBe(platform !== 'win32')
        if (platform !== 'win32') expect(command.args).toContain('1001:1002')
      }
    }
  })
  it('restricts Windows file paths only when using Linux containers', async () => {
    const { runtime, source } = await platformRuntime(platform)
    source.input.system_model_file = 'C:\\cases\\network.case.json'
    expect(
      (await runtime.simulationCommand(source, { method: 'installed', executable: '' })).stopArgs,
    ).toBeUndefined()
    const selected = runtime.simulationCommand(source, { method: 'docker', executable: '' })
    if (platform === 'win32') await expect(selected).rejects.toThrow('forward slashes')
    else await expect(selected).resolves.toBeDefined()
  })
})

function child() {
  const value = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  return value as unknown as childProcess.ChildProcessWithoutNullStreams
}
it('streams real process output and passes paths as arguments without a shell', async () => {
  const script = path.join(root, 'case $(echo bad); script.js')
  await fs.writeFile(
    script,
    `process.stdout.write(process.argv[2]); process.stderr.write('solver detail')`,
  )
  const output: string[] = []
  const errors: string[] = []
  const execution = executeSolver(
    { executable: process.execPath, args: [script, 'literal $(echo bad)'], cwd: root },
    (stream, text) => (stream === 'stdout' ? output : errors).push(text),
  )
  expect(await execution.done).toBe(0)
  expect(output.join('')).toContain('literal $(echo bad)')
  expect(errors.join('')).toBe('solver detail')
  await execution.cancel()
})
it('waits for container removal before completing a cancelled simulation', async () => {
  const running = child()
  const removal = child()
  const spawn = vi
    .spyOn(childProcess, 'spawn')
    .mockReturnValueOnce(running)
    .mockReturnValueOnce(removal)
  const execution = executeSolver(
    {
      executable: 'selected-podman',
      args: ['run'],
      cwd: root,
      stopArgs: ['rm', '-f', 'only-this-container'],
    },
    () => {},
  )
  const cancellation = execution.cancel()
  expect(execution.cancel()).toBe(cancellation)
  expect(running.kill).toHaveBeenCalledWith('SIGTERM')
  running.emit('close', 143)
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
  expect(spawn.mock.calls[1][0]).toBe('selected-podman')
  expect(spawn.mock.calls[1][1]).toEqual(['rm', '-f', 'only-this-container'])
  let done = false
  void execution.done.then(() => {
    done = true
  })
  await Promise.resolve()
  expect(done).toBe(false)
  removal.emit('close', 0)
  await cancellation
  expect(await execution.done).toBe(143)
})
it('reports container cleanup errors before the task finishes', async () => {
  const running = child()
  const removal = child()
  vi.spyOn(childProcess, 'spawn').mockReturnValueOnce(running).mockReturnValueOnce(removal)
  const messages: string[] = []
  const execution = executeSolver(
    { executable: 'docker', args: ['run'], cwd: root, stopArgs: ['rm', '-f', 'owned'] },
    (_stream, text) => messages.push(text),
  )
  const cancellation = execution.cancel()
  running.emit('close', 143)
  await vi.waitFor(() => expect(removal.listenerCount('close')).toBe(1))
  removal.stderr.emit('data', 'permission denied')
  removal.emit('close', 1)
  await cancellation
  await execution.done
  expect(messages.join('')).toContain('Container cleanup: permission denied')
})
it('escalates a native process that ignores termination', async () => {
  vi.useFakeTimers()
  const running = child()
  vi.spyOn(childProcess, 'spawn').mockReturnValueOnce(running)
  const execution = executeSolver(
    { executable: 'DynamicSimulation', args: [], cwd: root },
    () => {},
  )
  const cancellation = execution.cancel()
  await vi.advanceTimersByTimeAsync(3000)
  expect(running.kill).toHaveBeenLastCalledWith('SIGKILL')
  running.emit('close', null)
  await cancellation
  expect(await execution.done).toBe(1)
})
it('preserves launch errors without trying another executable', async () => {
  const running = child()
  const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValueOnce(running)
  const execution = executeSolver(
    { executable: '/selected/DynamicSimulation', args: [], cwd: root },
    () => {},
  )
  const failed = expect(execution.done).rejects.toThrow('loader missing')
  running.emit('error', new Error('loader missing'))
  await failed
  await execution.cancel()
  expect(spawn).toHaveBeenCalledTimes(1)
})
it('preserves Podman error messages for Simulation and the task terminal', () => {
  const output = new SolverOutput(() => {})
  output.write('stderr', 'Error: cannot connect to Podman socket\n')
  output.finish()
  expect(output.failure).toBe('Error: cannot connect to Podman socket')
})

it('pulls the latest GHCR image while retaining the selected engine for a case', async () => {
  await executable('docker')
  vi.stubEnv('PATH', root)
  const command = await simulationCommand(launch(), auto)
  expect(command.args).toContain('ghcr.io/lukelowry/gridkit:latest')
  expect(command.args).toContain('--pull=always')
  expect(command.args.some((arg) => arg.startsWith('--platform'))).toBe(false)
  const installed = await executable('DynamicSimulation')
  expect((await simulationCommand(launch(), auto, command.runtime)).executable).toBe(
    command.executable,
  )
  await fs.unlink(command.executable)
  await expect(simulationCommand(launch(), auto, command.runtime)).rejects.toThrow(
    'no longer available',
  )
  expect((await simulationCommand(launch(), auto)).executable).toBe(installed)
})
