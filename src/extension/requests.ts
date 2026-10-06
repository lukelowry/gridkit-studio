import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { problem } from '../shared/ai.js'

export interface Receipt {
  format: 1
  requestId: string
  kind: 'case-edit' | 'simulation'
  payloadHash: string
  resourceId: string
  state: 'reserved' | 'prepared' | 'accepted' | 'completed' | 'failed' | 'unknown'
  beforeRevision?: string
  afterRevision?: string
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

/** Canonical JSON: property order never makes a retry a different request. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value)
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Per-workspace receipts. A lost response never authorizes replay of a side effect. */
export class Requests {
  readonly #pending = new Map<string, Promise<Record<string, unknown>>>()
  constructor(readonly directory: string) {}

  async #save(key: string, receipt: Receipt) {
    const path = join(this.directory, key + '.json')
    const temporary = path + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 })
    await rename(temporary, path)
  }

  perform<T extends { requestId: string }>(
    kind: Receipt['kind'],
    input: T,
    execute: (receipt: Receipt, save: () => Promise<void>) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    if (!input.requestId?.trim()) return Promise.reject(problem('invalid-input', 'Supply a requestId.'))
    const key = hash(kind + '\0' + input.requestId)
    const payloadHash = hash(canonical(input))
    const previous = this.#pending.get(key)
    // Check the persisted payload after any concurrent request has established its receipt.
    const perform = async () => {
      await mkdir(this.directory, { recursive: true })
      const path = join(this.directory, key + '.json')
      let receipt: Receipt
      try {
        receipt = JSON.parse(await readFile(path, 'utf8')) as Receipt
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        receipt = { format: 1, requestId: input.requestId, kind, payloadHash, resourceId: randomUUID(), state: 'reserved' }
        const reservation = path + '.' + randomUUID() + '.tmp'
        try {
          // Publish a complete file exclusively; another window never reads a partial receipt.
          await writeFile(reservation, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
          await link(reservation, path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return perform()
          throw error
        } finally { await rm(reservation, { force: true }) }
        const save = () => this.#save(key, receipt)
        try {
          const result = await execute(receipt, save)
          receipt.result = result
          receipt.state = 'completed'
          await save()
          return result
        } catch (error) {
          // Once applying/acceptance begins, failure to receive an answer is not proof of failure.
          receipt.state = receipt.state === 'reserved' ? 'failed' : 'unknown'
          receipt.error = { code: (error as { code?: string }).code ?? 'operation-failed', message: error instanceof Error ? error.message : String(error) }
          await save()
          throw error
        }
      }
      if (receipt.payloadHash !== payloadHash)
        throw problem('request-conflict', 'This requestId was already used with different input.', { requestId: input.requestId })
      if (receipt.result) return receipt.result
      if (receipt.state === 'failed') throw problem(receipt.error?.code ?? 'operation-failed', receipt.error?.message ?? 'The request failed.')
      return {
        requestId: receipt.requestId,
        ...(kind === 'simulation' ? { simulationId: receipt.resourceId } : { changeId: receipt.resourceId }),
        status: 'unknown',
        message: 'The earlier request has no confirmed outcome. Inspect its simulation or the case before submitting different work.',
        beforeRevision: receipt.beforeRevision,
        afterRevision: receipt.afterRevision,
      }
    }
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(perform)
    this.#pending.set(key, pending)
    void pending.finally(() => { if (this.#pending.get(key) === pending) this.#pending.delete(key) }).catch(() => {})
    return pending
  }
}
