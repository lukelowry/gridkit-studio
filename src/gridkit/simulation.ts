import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type Arguments,
  type Command,
  type CommandContext,
  failure,
  type Parameters,
} from '@latkit/model'

import type { RunInfo, RunRequest, RuntimeProcess } from '../messages.js'
import { type ResultCache, Results } from '../results/results.js'
import type { Case } from './case.js'
import { diagnose } from './edits.js'
import { commandOf, parametersOf, selections } from './parameters.js'
import { launch } from './runtime.js'
import { caseFile, faultOrdinal, faultRecord, inputOf, monitorsOf } from './staging.js'

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
    if (invalid) throw failure('invalid-input', invalid.message)
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
      throw failure('invalid-input', 'Record at least one signal: turn one on under Monitors.')
    const columns = outputs.reduce((n, field) => n + field.rows.length, 1)
    if (columns * 8 > 8 << 20) throw failure('resource-limit', 'One selected frame exceeds 8 MiB.')
    this.results = new Results(this.info, this.kase, outputs, this.cache, this.directory)
    const staged = caseFile(
      this.kase,
      monitorsOf(this.kase, outputs),
      command.fault ? faultRecord(this.kase, command.fault) : null,
    )
    const handle = await import('node:fs/promises').then((fs) =>
      fs.open(join(this.directory, 'case.json'), 'w'),
    )
    try {
      for (const bytes of staged) await handle.write(bytes)
    } finally {
      await handle.close()
    }
    const text = inputOf(
      command,
      'case.json',
      {
        file: 'results.' + command.format,
        rows: Math.max(1, Math.min(64, Math.floor(context.maxBlockBytes / (columns * 8)))),
      },
      faultOrdinal(this.kase),
    )

    await writeFile(join(this.directory, 'input.json'), text)
    const process = await launch(
      this.request.runtime,
      this.directory,
      context.signal,
      (message) => context.log({ severity: 'info', message }),
      this.lifecycle,
    )
    try {
      await this.results.ingest(context.signal, process.ended, async (batches) => {
        await context.publish(batches)
        context.progress({
          completed: this.info.domain[1],
          total: command.domain[1],
          domain: this.info.domain,
        })
      })
      await process.done
    } finally {
      await process.stop()
      await process.done.catch(() => {})
    }
  }
}
