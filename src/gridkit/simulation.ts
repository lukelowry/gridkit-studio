import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { type Arguments, type Command, type CommandContext, type Parameters } from '@latkit/model'

import { type ResultCache, Results } from '../results/index.js'
import type { RuntimeProcess, SimulationInfo, SimulationRequest } from '../shared/messages.js'
import type { Case } from './case.js'
import { type Field, parametersOf, type SimulationCommand } from './parameters.js'
import { preflight } from './preflight.js'
import { launch } from './runtime.js'
import { caseFile, faultOrdinal, inputOf, monitorsOf } from './staging.js'

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
    readonly request: SimulationRequest,
    readonly directory: string,
    readonly cache: ResultCache,
    readonly info: SimulationInfo,
    readonly lifecycle?: (process?: RuntimeProcess) => void,
  ) {
    this.parameters = parametersOf(kase.catalog)
  }
  async run(input: Arguments<Parameters>, context: CommandContext): Promise<void> {
    context.signal.throwIfAborted()
    const { values, command, outputs, faults } = preflight(this.kase, input, context.outputs)
    this.info.configuration = {
      values: structuredClone(values),
      program: command.program,
      options: command.options.map(({ option, value }) => ({ name: option.id, value })),
      addedFaults: structuredClone(command.faults),
    }
    this.info.span = [command.domain[0], command.domain[1]]
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
    this.info.configuration.runtime = process.runtime
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
