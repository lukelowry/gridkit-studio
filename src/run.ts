import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'

import * as vscode from 'vscode'

import type { CaseState } from './case.js'
import { bindColumns } from './csv/columns.js'
import { CsvSource } from './csv/source.js'
import { solverDiagnostic } from './diagnostics.js'
import { describe } from './errors.js'
import { SolverOutput } from './gridkit/output.js'
import { indexMonitoring } from './gridkit/parse.js'
import type { SolverLaunch } from './launch.js'
import { executeSolver, type Execution, type SimulationCommand } from './runtime.js'
import type { CaseTarget } from './targets.js'

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed'
export class Run {
  readonly id = randomUUID()
  readonly monitoring
  readonly done: Promise<RunStatus>
  target: CaseTarget
  status: RunStatus = 'running'
  taskName?: string
  terminal?: vscode.Terminal
  error?: string
  dataError?: string
  private finished!: (status: RunStatus) => void
  private execution?: Execution
  private timer?: ReturnType<typeof setTimeout>
  private started = false
  private cancelled = false
  private disposed = false
  private reading: Promise<void> = Promise.resolve()
  private before?: string
  private source?: CsvSource
  private disposal?: Promise<void>
  constructor(
    readonly state: CaseState,
    readonly launch: SolverLaunch,
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly command: SimulationCommand,
    readonly provenance?: Readonly<Record<string, unknown>>,
  ) {
    this.target = state.target
    this.monitoring = indexMonitoring(launch.raw)
    this.done = new Promise((resolve) => {
      this.finished = resolve
    })
  }
  get stopping(): boolean {
    return this.cancelled && this.status === 'running'
  }
  private async fingerprint(): Promise<string | undefined> {
    try {
      const value = await stat(this.launch.output)
      return `${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
  private refresh(final: boolean): Promise<void> {
    return (this.reading = this.reading
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed || !this.state.current(this.target)) return
        if (!this.state.source) {
          const fingerprint = await this.fingerprint()
          if (!fingerprint || fingerprint === this.before) {
            const monitored = [...this.launch.raw.buses, ...this.launch.raw.devices].some(
              (element) => element.mon?.length,
            )
            if (final && monitored) throw new Error('GridKit did not produce new CSV output.')
            return
          }
          this.source = new CsvSource(this.launch.output)
          await this.state.attachSource(this.source)
        }
        const source = this.state.source!
        const previous = source.info?.rows
        const info = await source.scan(final)
        if (info.headers.length && !source.columns.length)
          source.columns = bindColumns(this.launch.raw, this.state.fields!.model, info.headers)
        if (this.disposed || !this.state.current(this.target)) return
        if (previous !== info.rows) {
          this.state.timeline.update(info.range)
          this.state.resultsChanged()
        }
        if (final) {
          if (!info.rows) throw new Error('GridKit produced no monitor samples.')
          const expected = [...this.monitoring.values()].reduce(
            (count, elements) => count + elements.size,
            0,
          )
          if (source.columns.length !== expected)
            throw new Error('GridKit output is missing declared monitor columns.')
        }
        this.dataError = undefined
      }))
  }
  async start(write: (text: string) => void): Promise<number> {
    if (this.status === 'cancelled') return 130
    if (this.started) throw new Error('This simulation has already been started.')
    this.started = true
    const diagnostics: vscode.Diagnostic[] = []
    const output = new SolverOutput((issue) => {
      if (!this.state.current(this.target)) return
      const diagnostic = solverDiagnostic(this.state, issue)
      if (diagnostic && !diagnostics.some((value) => value.message === diagnostic.message)) {
        diagnostics.push(diagnostic)
        this.diagnostics.set(this.state.document.uri, diagnostics)
        write(
          `\r\n${this.state.document.uri.fsPath}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${issue.message}\r\n`,
        )
      }
    })
    try {
      this.before = await this.fingerprint()
      if (this.cancelled || this.disposed) {
        this.status = 'cancelled'
        return 130
      }
      this.launch.assertCurrent?.()
      this.execution = executeSolver(this.command, (stream, text) => {
        write(text)
        output.write(stream, text)
      })
      let polling = true
      let readFailures = 0
      const poll = () => {
        this.timer = setTimeout(
          () => {
            void this.refresh(false)
              .then(
                () => {
                  readFailures = 0
                },
                (error) => {
                  readFailures++
                  this.dataError = describe(error)
                  this.state.resultsChanged()
                },
              )
              .then(() => {
                if (polling && !this.cancelled && !this.disposed && readFailures < 3) poll()
              })
          },
          Math.min(300 * 2 ** readFailures, 3000),
        )
      }
      poll()
      let code: number
      try {
        code = await this.execution.done
      } finally {
        polling = false
        clearTimeout(this.timer)
      }
      output.finish()
      try {
        await this.refresh(code === 0 && !this.cancelled)
      } catch (error) {
        this.dataError = describe(error)
      }
      if (this.cancelled) {
        this.status = 'cancelled'
        return 130
      }
      if (code !== 0 || output.failure)
        throw new Error(
          output.failure ??
            (output.comparisonFailed
              ? 'Simulation completed; reference comparison failed. See the task terminal.'
              : `DynamicSimulation exited with code ${code}. See the task terminal.`),
        )
      if (this.dataError)
        throw new Error(`Simulation output could not be loaded: ${this.dataError}`)
      await this.launch.publish?.()
      this.status = 'completed'
      return 0
    } catch (error) {
      this.status = this.cancelled ? 'cancelled' : 'failed'
      this.error = describe(error)
      write(`\r\n${this.error}\r\n`)
      return this.cancelled ? 130 : 1
    } finally {
      output.finish()
      await this.finish(write)
    }
  }
  private async finish(write: (text: string) => void): Promise<void> {
    clearTimeout(this.timer)
    if (this.dataError) write(`\r\nMonitor: ${this.dataError}\r\n`)
    if (this.state.current(this.target) && !this.disposed) this.state.resultsChanged()
    try {
      await this.launch.cleanup?.()
    } catch (error) {
      write(`\r\nCleanup: Cannot remove temporary simulation input: ${describe(error)}\r\n`)
    }
    this.finished(this.status)
  }

  async cancel(): Promise<void> {
    if (this.status !== 'running') return
    this.cancelled = true
    this.state.resultsChanged()
    clearTimeout(this.timer)
    if (!this.started) {
      this.status = 'cancelled'
      await this.finish(() => {})
    } else await this.execution?.cancel()
  }
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.disposed = true
      await this.cancel()
      if (this.started) await this.done
      await this.reading.catch(() => {})
      try {
        await this.source?.dispose()
      } finally {
        try {
          await this.launch.dispose?.()
        } finally {
          this.diagnostics.delete(this.state.document.uri)
        }
      }
    })())
  }
}
