import type { SolverStream } from '../runtime.js'
export interface SolverIssue {
  severity: 'error' | 'warning'
  message: string
  device?: { className: string; id: string }
  parameter?: string
}
interface Stream {
  line: string
  pending?: SolverIssue
}
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g
const generic = (message: string) => /^(error|failed|failure)[.!:]?$/i.test(message.trim())
/** Raw output always goes directly to the terminal. Each pipe has independent line framing. */
export class SolverOutput {
  private readonly streams: Record<SolverStream, Stream> = {
    stdout: { line: '' },
    stderr: { line: '' },
  }
  failure?: string
  comparisonFailed = false
  constructor(private readonly issue: (issue: SolverIssue) => void) {}
  write(stream: SolverStream, chunk: string): void {
    const state = this.streams[stream]
    const lines = (state.line + chunk).split(/\r?\n/)
    state.line = lines.pop()!
    for (const line of lines) this.accept(state, line.replace(ansi, ''))
  }
  finish(): void {
    for (const state of Object.values(this.streams)) {
      if (state.line) this.accept(state, state.line.replace(ansi, ''))
      state.line = ''
      this.flush(state)
    }
  }
  private accept(state: Stream, line: string): void {
    const text = line.trim()
    const level = /^\[(ERROR|WARNING)\]\s*(.*)/i.exec(text)
    if (level) {
      this.flush(state)
      state.pending = {
        severity: level[1].toUpperCase() === 'ERROR' ? 'error' : 'warning',
        message: level[2],
      }
      return
    }
    if (
      /terminate called|what\(\):|\[IDA[^\]]*ERROR\]|SUNDIALS_ERROR|^docker:|^podman:|^Error:|^Error response from daemon/i.test(
        text,
      )
    ) {
      if (state.pending?.severity === 'warning') this.flush(state)
      state.pending ??= { severity: 'error', message: '' }
      state.pending.message += (state.pending.message ? '\n' : '') + text
      return
    }
    if (
      /monitor file vs reference file.*(FAIL|NOT PASS)|(FAIL|NOT PASS).*monitor file vs reference file/i.test(
        text,
      )
    )
      this.comparisonFailed = true
    // Explanations are not required to be indented. Explicit logger boundaries end the block.
    if (state.pending && text && !/^\[(INFO|DEBUG|TRACE)\]|^Complete in |^---/i.test(text)) {
      state.pending.message += (state.pending.message ? '\n' : '') + text
      return
    }
    this.flush(state)
  }
  private flush(state: Stream): void {
    const issue = state.pending
    state.pending = undefined
    if (!issue?.message.trim()) return
    const device = /"([^"\n]+)" device with "id": "([^"\n]+)"/.exec(issue.message)
    if (device) issue.device = { className: device[1], id: device[2] }
    issue.parameter = /parameter(?: value type)?[ :]*"([^"\n]+)"/i.exec(issue.message)?.[1]
    if (
      issue.severity === 'error' &&
      (!this.failure || (generic(this.failure) && !generic(issue.message)))
    )
      this.failure = issue.message
    this.issue(issue)
  }
}
