import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdtemp, open, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { GRIDKIT_REVISION } from './gridkit/contract.js'
import { changeJson } from './gridkit/edit.js'
import { canonical, resolveSolver, type SolverLaunch, within } from './launch.js'
import type { SimulationCommand } from './runtime.js'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function hashFile(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path, { signal })) hash.update(bytes)
  return hash.digest('hex')
}
async function copyReference(from: string, to: string, signal?: AbortSignal) {
  const source = await open(from, 'r')
  try {
    const before = await source.stat()
    const hash = createHash('sha256')
    await pipeline(
      source.createReadStream({ autoClose: false }),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          callback(null, chunk)
        },
      }),
      createWriteStream(to, { flags: 'wx' }),
      { signal },
    )
    const after = await source.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('The reference file changed while preparing the simulation. Run again.')
    return hash.digest('hex')
  } finally {
    await source.close()
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export async function stageLaunch(
  original: SolverLaunch,
  signal?: AbortSignal,
): Promise<SolverLaunch> {
  signal?.throwIfAborted()
  original.assertCurrent?.()
  if (!original.sourceText) throw new Error('Simulation input bytes were not captured.')
  const directory = await mkdtemp(join(original.root, '.gridkit-run-'))
  if (!within(original.root, directory)) throw new Error('Invalid simulation staging directory.')
  let disposal: Promise<void> | undefined
  const dispose = () =>
    (disposal ??= rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  try {
    let caseText = original.sourceText.case
    let solverText = changeJson(
      original.sourceText.solver,
      ['system_model_file'],
      'input.case.json',
    )
    const exports: { from: string; to: string }[] = []
    const sinks = original.raw.monitors ?? []
    for (let i = 0; i < sinks.length; i++) {
      if (!sinks[i].file_name) continue
      const name = 'monitor-' + i + '.csv'
      caseText = changeJson(caseText, ['monitors', i, 'file_name'], name)
      exports.push({
        from: join(directory, name),
        to: await canonical(resolve(original.cwd, sinks[i].file_name!)),
      })
    }
    if (exports.some((output) => !original.outputs.includes(output.to)))
      throw new Error('Monitor output paths changed while preparing the simulation.')
    const modelOutput = sinks.at(-1)?.file_name
    solverText = changeJson(solverText, ['output_file'], modelOutput ? undefined : 'output.csv')
    if (!modelOutput) exports.push({ from: join(directory, 'output.csv'), to: original.output })
    else if (original.input.output_file)
      exports.push({
        from: join(directory, 'monitor-' + (sinks.length - 1) + '.csv'),
        to: await canonical(resolve(original.cwd, original.input.output_file)),
      })
    if (exports.some((output) => !original.outputs.includes(output.to)))
      throw new Error('Monitor output paths changed while preparing the simulation.')
    let referenceHash: string | undefined
    if (original.input.reference_file) {
      referenceHash = await copyReference(
        resolve(original.cwd, original.input.reference_file),
        join(directory, 'reference.csv'),
        signal,
      )
      solverText = changeJson(solverText, ['reference_file'], 'reference.csv')
    }
    await writeFile(join(directory, 'input.case.json'), caseText, { flag: 'wx' })
    await writeFile(join(directory, 'input.solver.json'), solverText, { flag: 'wx' })
    const staged = await resolveSolver(join(directory, 'input.solver.json'), original.root)
    signal?.throwIfAborted()
    original.assertCurrent?.()
    const provenance = freeze({
      contractRevision: GRIDKIT_REVISION,
      inputs: {
        case: digest(caseText),
        solver: digest(solverText),
        ...(referenceHash && { reference: referenceHash }),
      },
      sourceInputs: {
        case: digest(original.sourceText.case),
        solver: digest(original.sourceText.solver),
      },
    })
    let publishing: Promise<void> | undefined
    const publish = () =>
      (publishing ??= (async () => {
        for (const output of exports) {
          // Replace each complete file in its destination directory; readers never see a partial copy.
          const target = output.to
          if ((await canonical(target)) !== target)
            throw new Error('A monitor output path changed during the simulation.')
          const temporary = join(dirname(target), '.gridkit-export-' + randomUUID())
          try {
            await copyFile(output.from, temporary)
            await rename(temporary, target)
          } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
            })
          }
        }
      })())
    return Object.freeze({
      ...staged,
      raw: freeze(staged.raw),
      input: freeze(staged.input),
      outputs: Object.freeze([...original.outputs]),
      assertCurrent: original.assertCurrent,
      cleanup: original.cleanup,
      dispose,
      publish,
      provenance,
    })
  } catch (error) {
    await dispose()
    throw error
  }
}
export async function recordRuntime(
  launch: SolverLaunch,
  command: SimulationCommand,
  signal?: AbortSignal,
) {
  const runtime = command.runtime?.image
    ? { ...command.runtime }
    : {
        ...command.runtime,
        executableSha256: await hashFile(command.executable, signal),
        platform: process.platform + '/' + process.arch,
      }
  const provenance = freeze({ ...launch.provenance, runtime })
  await writeFile(join(launch.cwd, 'run.json'), JSON.stringify(provenance, null, 2) + '\n', {
    flag: 'wx',
  })
  return provenance
}
