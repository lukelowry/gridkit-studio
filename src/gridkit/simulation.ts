import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  type Arguments,
  type Command,
  type CommandContext,
  failure,
  type Parameters,
} from '@latkit/model'

import { BATCH_BYTES, type ResultCache, Results } from '../results/index.js'
import type { RunInfo, RunRequest, RuntimeProcess } from '../shared/messages.js'
import type { Case } from './case.js'
import { diagnose } from './edits.js'
import {
  commandOf,
  type Field,
  parametersOf,
  selections,
  type SimulationCommand,
} from './parameters.js'
import { launch } from './runtime.js'
import { caseFile, faultOrdinal, faultRecords, inputOf, monitorsOf } from './staging.js'

/** The file ContingencyAnalysis writes for its fault `ordinal` from the sink `results.csv`, as
 *  GridKit names it: `name + "_" + fault_id + ext`. */
export const contingencyFile = (ordinal: number) => `results_${ordinal}.csv`

/** One run of a case, staged in `directory` and read as GridKit writes it: a DynamicSimulation, or
 *  a ContingencyAnalysis that faults every bus in turn, one contingency of which shows. */
export class Simulation implements Command {
  readonly parameters
  results?: Results
  constructor(
    readonly kase: Case,
    readonly request: RunRequest,
    readonly directory: string,
    readonly cache: ResultCache,
    readonly info: RunInfo,
    readonly lifecycle?: (process?: RuntimeProcess) => void,
  ) {
    this.parameters = parametersOf(kase.catalog)
  }
  async run(input: Arguments<Parameters>, context: CommandContext): Promise<void> {
    context.signal.throwIfAborted()
    this.kase.checkSignals()
    const invalid = diagnose(this.kase).find((issue) => issue.severity === 'error')
    if (invalid) throw failure('invalid-input', `${invalid.id ?? 'Case'}: ${invalid.message}`)
    for (const name of Object.keys(input))
      if (!(name in this.parameters))
        throw failure('invalid-input', 'Unknown simulation parameter: ' + name)
    const values: Record<string, unknown> = {}
    for (const [name, parameter] of Object.entries(this.parameters)) {
      const value = input[name] ?? ('default' in parameter ? parameter.default : undefined)
      if (value === undefined && parameter.optional) continue
      const valid =
        parameter.type === 'number'
          ? typeof value === 'number' &&
            Number.isFinite(value) &&
            (!parameter.integer || Number.isInteger(value)) &&
            (parameter.min === undefined || value >= parameter.min) &&
            (parameter.max === undefined || value <= parameter.max)
          : parameter.type === 'boolean'
            ? typeof value === 'boolean'
            : parameter.type === 'choice'
              ? typeof value === 'string' && parameter.choices.includes(value)
              : typeof value === 'string'
      if (!valid) throw failure('invalid-input', `Invalid value for ${name}.`)
      values[name] = value
    }
    const command = commandOf(this.kase, values as Arguments<Parameters>)
    this.info.span = [command.domain[0], command.domain[1]]
    const outputs = selections(this.kase, context.outputs)
    if (!outputs.length)
      throw failure('invalid-input', 'Choose at least one monitored signal to run.')
    const columns = outputs.reduce((n, field) => n + field.rows.length, 1)
    if (columns * 8 > BATCH_BYTES)
      throw failure('resource-limit', 'One selected frame exceeds 8 MiB.')
    const faults = faultRecords(this.kase, command.faults)
    const ordinal = faultOrdinal(this.kase)
    await writeFile(
      join(this.directory, 'case.json'),
      caseFile(this.kase, monitorsOf(this.kase, outputs), faults.text),
    )
    await writeFile(join(this.directory, 'input.json'), inputOf(command, 'case.json', ordinal))
    const process = await launch(
      this.request.gridkit,
      command.program,
      this.directory,
      context.signal,
      (message) => context.log({ severity: 'info', message }),
      this.lifecycle,
    )
    try {
      if (command.program === 'ContingencyAnalysis')
        await this.#study(command, faults.ids, ordinal, outputs, process, context)
      else {
        this.results = new Results(this.info, this.kase, outputs, this.cache, this.directory)
        await this.results.ingest(context.signal, process.ended, async (batches) => {
          await context.publish(batches)
          context.progress({
            completed: this.info.domain[1],
            total: command.domain[1],
            domain: this.info.domain,
          })
        })
        await process.done
        if (!this.info.frames) throw new Error('DynamicSimulation produced no samples.')
      }
    } catch (error) {
      context.signal.throwIfAborted()
      // A native error is more useful than the missing result file it caused.
      if (process.ended()) await process.done
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `${command.program} produced no results. See ${join(this.directory, 'solver.log')}.`,
        )
      throw error
    } finally {
      await process.stop()
      await process.done.catch(() => {})
    }
  }

  /** Counts each contingency's file as GridKit finishes it, then shows the first that succeeded.
   *  The case's own faults come first in GridKit's order, so contingency `n` is fault
   *  `ordinal + n`. */
  async #study(
    command: SimulationCommand,
    ids: readonly string[],
    ordinal: number,
    outputs: readonly Field[],
    process: Awaited<ReturnType<typeof launch>>,
    context: CommandContext,
  ) {
    const count = command.faults.length
    const contingency = {
      study: this.info.id,
      offset: ordinal,
      buses: command.faults.map(({ bus }) => bus),
      failed: [] as number[],
      done: 0,
      shown: 0,
    }
    this.info.contingency = contingency
    const progress = () =>
      context.progress({ completed: contingency.done, total: count, domain: this.info.domain })
    // GridKit writes one file after another; the newest is still being written.
    while (!process.ended()) {
      await delay(250, undefined, { signal: context.signal })
      const written = (await readdir(this.directory)).filter((name) => {
        const match = /^results_(\d+)\.csv$/.exec(name)
        return match !== null && Number(match[1]) >= ordinal
      }).length
      if (written - 1 > contingency.done) {
        contingency.done = written - 1
        progress()
      }
    }
    await process.done
    contingency.failed = ids.flatMap((id, n) => (process.failed().has(id) ? [n] : []))
    contingency.done = count
    const shown = ids.findIndex((_, n) => !contingency.failed.includes(n))
    if (shown < 0) throw new Error('Every contingency failed. See the solver log.')
    contingency.shown = shown
    this.info.path = join(this.directory, contingencyFile(ordinal + shown))
    this.results = new Results(this.info, this.kase, outputs, this.cache, this.directory)
    await this.results.ingest(context.signal, () => true, context.publish)
    progress()
  }
}
