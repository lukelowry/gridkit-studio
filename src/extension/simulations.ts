import * as vscode from 'vscode'

import type { SimulateInput } from '../shared/ai.js'
import type { SimulationInfo, SimulationRequest } from '../shared/messages.js'
import { resolveCase, revision } from './ai/context.js'
import type { Requests } from './requests.js'
import { defaultOutputs, type Sessions } from './sessions.js'
import { cacheBytesOf, gridkitOf, type Tasks } from './tasks.js'

export function simulationSummary(info: SimulationInfo, include: readonly string[] = []) {
  return {
    simulationId: info.contingency?.study ?? info.id, caseUri: info.revision.uri,
    caseRevision: info.fingerprint, name: info.name, status: info.state,
    frames: info.frames, timeRange: info.domain, expectedTimeRange: info.span,
    started: info.started, message: info.message, recordingEvicted: info.evicted ?? false,
    ...(info.contingency ? { contingencyIndex: info.contingency.shown, completed: info.contingency.done, scenarios: info.contingency.buses.length, failedContingencies: info.contingency.failed } : {}),
    ...(include.includes('configuration') ? { configuration: info.configuration ?? null } : {}),
    ...(include.includes('recording') ? { recording: info.outputs.map(output => ({ componentType: output.from, fields: output.select, ...(output.rows?.kind === 'ids' ? { componentIds: output.rows.ids } : {}) })) } : {}),
    ...(include.includes('logs') ? { logs: info.evidence ?? [] } : {}),
  }
}

/** Accept a durable identity before VS Code schedules its native task. */
export class Simulations {
  constructor(readonly studio: Sessions, readonly tasks: Tasks, readonly requests: Requests) {}
  async submit(input: SimulateInput, signal: AbortSignal) {
    const result = await this.requests.perform('simulation', input, async (receipt, save) => {
      const { document, summary } = await resolveCase(this.studio, input, signal)
      const session = await this.studio.open(document)
      const captured = await this.studio.client.call('captureCase', revision(summary), signal)
      try {
        const uri = vscode.Uri.parse(input.caseUri)
        const request: SimulationRequest = {
          ...revision(summary), simulationId: receipt.resourceId, snapshotId: captured.snapshotId,
          values: { ...session.values, ...input.parameters, program: input.program },
          outputs: input.recording ? await this.studio.client.call('resolveRecording', { snapshotId: captured.snapshotId, recording: input.recording }, signal) : session.outputs ?? defaultOutputs(summary),
          gridkit: gridkitOf(uri), cacheBytes: cacheBytesOf(uri),
        }
        signal.throwIfAborted()
        receipt.beforeRevision = captured.fingerprint
        receipt.state = 'prepared'
        await save()
        // After this boundary, a disconnected client cannot cancel accepted work.
        const info = await this.studio.client.call('prepareSimulation', request)
        receipt.state = 'accepted'
        await save()
        try { await this.tasks.start(request) }
        catch (error) {
          await this.studio.client.call('stopSimulation', { simulationId: info.id })
          throw error
        }
        return { requestId: input.requestId, ...simulationSummary(info, ['configuration', 'recording']) }
      } finally {
        await this.studio.client.call('releaseSnapshot', { snapshotId: captured.snapshotId }).catch(() => {})
      }
    })
    if (typeof result.simulationId === 'string') {
      try {
        const info = await this.studio.client.call('getSimulation', { simulationId: result.simulationId }, signal)
        return { ...result, ...simulationSummary(info, ['configuration', 'recording']) }
      } catch { /* A crash before acceptance leaves an explicitly uncertain receipt. */ }
    }
    return result
  }
}
