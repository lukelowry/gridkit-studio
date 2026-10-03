import { copyFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  type Arguments,
  type Command,
  type CommandContext,
  failure,
  type Parameters,
} from '@latkit/model'
import { modify } from 'jsonc-parser'

import type { RunInfo, RunRequest, RuntimeProcess } from '../messages.js'
import { type ResultCache, Results } from '../results/results.js'
import type { Case } from './case.js'
import { parseSolver } from './configuration.js'
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
    const configuration = this.request.configuration
    const legacy = configuration ? parseSolver(JSON.parse(configuration.text)) : undefined
    // Advanced local settings have their own compatibility rules (for example negative max_steps).
    const command = commandOf(this.kase, values as Arguments<Parameters>)
    const outputs = selections(this.kase, context.outputs)
    if (!outputs.length) throw failure('invalid-input', 'Select at least one output in Signals.')
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
    let text = inputOf(
      command,
      'case.json',
      {
        file: 'results.' + command.format,
        rows: Math.max(1, Math.min(64, Math.floor(context.maxBlockBytes / (columns * 8)))),
      },
      faultOrdinal(this.kase),
    )

    if (legacy && configuration) {
      if (command.fault)
        throw failure(
          'invalid-input',
          'Use configuration events or the simple fault controls, not both.',
        )
      const monitor = JSON.parse(text).monitors
      // Preserve advanced options, unknown members and original real-number tokens.
      text = configuration.text
      const replace = (key: string, value: unknown) => {
        for (const edit of modify(text, [key], value, {}).reverse())
          text = text.slice(0, edit.offset) + edit.content + text.slice(edit.offset + edit.length)
      }
      replace('system_model_file', 'case.json')
      if (legacy.reference_file && command.format === 'arrow')
        monitor.push({ file_name: 'comparison.csv', format: 'csv' })
      replace('monitors', monitor)
      replace('output_file', undefined)
      if (legacy.reference_file) {
        await copyFile(
          resolve(configuration.directory, legacy.reference_file),
          join(this.directory, 'reference.csv'),
        )
        replace('reference_file', 'reference.csv')
      }
    }
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
          total: legacy?.tmax ?? command.domain[1],
          domain: this.info.domain,
        })
      })
      await process.done
      if (legacy?.output_file && configuration) {
        const destination = resolve(configuration.directory, legacy.output_file)
        if (destination === resolve(configuration.directory, legacy.system_model_file))
          throw failure('invalid-input', 'Output file must not overwrite the case.')
        await this.results.exportCsv(destination, context.signal)
      }
    } finally {
      await process.stop()
      await process.done.catch(() => {})
    }
  }
}
