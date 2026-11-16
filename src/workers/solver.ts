/** GridKit WASM. Only prepared inputs and explicit monitor outputs enter its filesystem. */
import { applyEdits, modify } from 'jsonc-parser'

import type { WasmEvent, WasmInput } from '../gridkit/wasm.js'
import { readFile } from '../platform/files.js'
import { outputPath } from '../platform/host.js'
import { dirname, resolve } from '../platform/path.js'
import { cleanLog, linkOutput, loadFactory, outputFile } from '../platform/solver.js'
import { finish, port, workerData } from '../platform/worker.js'
import { fileKey } from '../results/store.js'

interface Stream {
  flags: number
  position: number
  seekable: boolean
  hostFd?: number
}
interface GridKitModule {
  FS: {
    mkdirTree(path: string): void
    writeFile(path: string, bytes: string | Uint8Array): void
    chdir(path: string): void
    symlink(target: string, path: string): void
    makedev(major: number, minor: number): number
    registerDevice(
      device: number,
      operations: {
        open(stream: Stream): void
        close(stream: Stream): void
        write(
          stream: Stream,
          bytes: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ): number
        read(
          stream: Stream,
          bytes: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ): number
        llseek(stream: Stream, offset: number, whence: number): number
      },
    ): void
    mkdev(path: string, device: number): void
  }
  callMain(args: string[]): number
}
type Factory = (options: {
  locateFile(name: string): string
  quit(status: number, error: unknown): never
  print(text: string): void
  printErr(text: string): void
  instantiateWasm(
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance) => void,
  ): object
}) => Promise<GridKitModule>

const { request, module, wasm, stop } = workerData as WasmInput
const send = (event: WasmEvent) => port.postMessage(event)
const files: Awaited<ReturnType<typeof outputFile>>[] = []
let errorLine = ''
/** Throws once the run is asked to stop. Thrown from a write or print, it unwinds `callMain`, and
 *  the files close as the worker exits. */
const checkStop = () => {
  if (stop && Atomics.load(stop, 0)) throw new Error('GridKit was stopped.')
}
/** Forwards each line GridKit prints to the run's log, which rate-limits them. */
const log = (text: string) => {
  checkStop()
  text = cleanLog(text)
  if (/\[ERROR\]/i.test(text)) errorLine = text
  send({ kind: 'log', text })
}

try {
  const compiled = await WebAssembly.compile(wasm)
  const create = (await loadFactory(module)) as Factory
  const gridkit = await create({
    locateFile: (name) => name,
    quit: (_status, error) => {
      throw error
    },
    print: log,
    printErr: log,
    instantiateWasm: (imports, done) => {
      done(new WebAssembly.Instance(compiled, imports))
      return {}
    },
  })
  const { FS } = gridkit
  FS.mkdirTree('/run/input')
  FS.mkdirTree('/run/output')
  FS.chdir('/run')
  const folder = dirname(request.solver)
  let studyText = await readFile(request.solver, 'utf8')
  const settings = JSON.parse(studyText) as Record<string, unknown>
  const modelPath = resolve(folder, String(settings.system_model_file))
  let modelText = await readFile(modelPath, 'utf8')
  const model = JSON.parse(modelText) as Record<string, unknown>
  const setStudy = (key: string, value: string) => {
    studyText = applyEdits(studyText, modify(studyText, [key], value, {}))
  }
  if (typeof settings.state_file === 'string' && settings.state_file)
    throw new Error(
      'The included GridKit build does not support state_file. Set GridKit Path to a build that does.',
    )
  const inputs = new Set([fileKey(request.solver), fileKey(modelPath)])
  for (const key of ['reference_file']) {
    const name = settings[key]
    if (typeof name !== 'string' || !name) continue
    const path = resolve(folder, name)
    inputs.add(fileKey(path))
    const staged = `/run/input/${key}`
    setStudy(key, staged)
    FS.writeFile(staged, await readFile(path))
  }
  setStudy('system_model_file', '/run/input/model.json')
  const outputs = new Map<string, string>()
  const output = async (name: string): Promise<string> => {
    const path = resolve(folder, name)
    const key = fileKey(path)
    if (inputs.has(key)) throw new Error(`A simulation output would overwrite an input: ${path}`)
    let virtual = outputs.get(key)
    if (virtual) return virtual
    virtual = `/run/output/${outputs.size}`
    outputs.set(key, virtual)
    const device = FS.makedev(64, outputs.size)
    const disk = await outputFile(path)
    files.push(disk)
    FS.registerDevice(device, {
      open(stream) {
        const writing = (stream.flags & 3) !== 0
        stream.hostFd = disk.open(writing)
        if (writing && fileKey(outputPath(path)) === fileKey(request.output))
          send({ kind: 'output' })
        stream.seekable = true
      },
      close(stream) {
        if (stream.hostFd !== undefined) {
          disk.close(stream.hostFd)
        }
      },
      write(stream, bytes, offset, length, position) {
        checkStop()
        let written = 0
        while (written < length) {
          const count = disk.write(
            stream.hostFd!,
            bytes,
            offset + written,
            length - written,
            position + written,
          )
          if (!count) throw new Error('GridKit output write made no progress.')
          written += count
        }
        return written
      },
      read: (stream, bytes, offset, length, position) =>
        disk.read(stream.hostFd!, bytes, offset, length, position),
      llseek: (stream, offset, whence) => {
        checkStop()
        return offset + (whence === 1 ? stream.position : whence === 2 ? disk.size() : 0)
      },
    })
    FS.mkdev(virtual, device)
    return virtual
  }
  let monitor: string | undefined
  if (Array.isArray(model.monitors))
    for (const [index, sink] of (model.monitors as Record<string, unknown>[]).entries()) {
      if (typeof sink.file_name === 'string' && sink.file_name) {
        modelText = applyEdits(
          modelText,
          modify(modelText, ['monitors', index, 'file_name'], await output(sink.file_name), {}),
        )
      }
      if (/^csv$/i.test(String(sink.format)) && (sink.delim ?? ',') === ',')
        monitor = typeof sink.file_name === 'string' ? sink.file_name : undefined
    }
  if (typeof settings.output_file === 'string' && settings.output_file) {
    if (monitor && String(settings.output_layout ?? 'wide').toLowerCase() === 'wide') {
      const target = resolve(folder, monitor)
      const alias = resolve(folder, settings.output_file)
      if (inputs.has(fileKey(alias)))
        throw new Error(`A simulation output would overwrite an input: ${alias}`)
      await linkOutput(target, alias)
      // GridKit expects a link when the study and case both specify an output.
      FS.symlink(await output(monitor), '/run/study-output')
      setStudy('output_file', '/run/study-output')
    } else setStudy('output_file', await output(settings.output_file))
  }
  // Patch path tokens only: GridKit distinguishes integer and floating-point JSON values.
  FS.writeFile('/run/input/model.json', modelText)
  FS.writeFile('/run/study.json', studyText)
  let status: number
  try {
    status = gridkit.callMain(['/run/study.json'])
  } catch (error) {
    if (typeof (error as { status?: unknown })?.status !== 'number') throw error
    status = (error as { status: number }).status
  }
  send({
    kind: 'exit',
    status,
    ...(status && { message: errorLine || `DynamicSimulation exited with code ${status}.` }),
  })
} catch (error) {
  send({ kind: 'exit', status: 1, message: error instanceof Error ? error.message : String(error) })
} finally {
  for (const file of files) file.dispose()
  finish()
}
