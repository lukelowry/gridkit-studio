import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type EvidencePage, pageOf } from '../shared/inspection.js'
import { Readers } from './readers.js'

const PAGE = 256
/** Immutable analysis rows live on disk. Paging them never rescans the result recording. */
export class Evidence {
  readonly #readers = new Readers<object>()
  readonly #entries = new Map<
    string,
    {
      uri: string
      summary: Record<string, unknown>
      path: string
      offsets: number[]
      total: number
    }
  >()
  constructor(readonly directory: string) {}
  async put(uri: string, result: { rows: unknown[] }, signal: AbortSignal) {
    const id = randomUUID()
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, id + '.jsonl')
    const file = await open(path, 'wx')
    const offsets = [0]
    try {
      for (let start = 0; start < result.rows.length; start += PAGE) {
        signal.throwIfAborted()
        const buffer = Buffer.from(JSON.stringify(result.rows.slice(start, start + PAGE)) + '\n')
        await file.writeFile(buffer)
        offsets.push(offsets.at(-1)! + buffer.byteLength)
      }
      signal.throwIfAborted()
      const { rows: _, ...summary } = result
      this.#entries.set(id, { uri, summary, path, offsets, total: result.rows.length })
      return id
    } catch (error) {
      await file.close()
      await rm(path, { force: true })
      throw error
    } finally {
      await file.close()
    }
  }
  async read(
    id: string,
    input: { offset?: number; limit?: number },
    signal: AbortSignal,
  ): Promise<EvidencePage> {
    const entry = this.#entries.get(id)
    if (!entry) throw new Error('Evidence is no longer available. Analyze the retained run again.')
    return this.#readers.use([entry], signal, async (signal) => {
      const { offset, limit } = pageOf(input)
      const end = Math.min(entry.total, offset + limit)
      const rows: unknown[] = []
      const file = await open(entry.path, 'r')
      try {
        for (let p = Math.floor(offset / PAGE); p * PAGE < end; p++) {
          signal.throwIfAborted()
          const buffer = Buffer.alloc(entry.offsets[p + 1]! - entry.offsets[p]!)
          let read = 0
          while (read < buffer.length) {
            const { bytesRead } = await file.read(
              buffer,
              read,
              buffer.length - read,
              entry.offsets[p]! + read,
            )
            if (!bytesRead) throw new Error('Evidence file is incomplete. Analyze the run again.')
            read += bytesRead
          }
          const page = JSON.parse(buffer.toString()) as unknown[]
          rows.push(...page.slice(Math.max(0, offset - p * PAGE), Math.min(PAGE, end - p * PAGE)))
        }
      } finally {
        await file.close()
      }
      return {
        evidence: id,
        summary: entry.summary,
        rows,
        offset,
        total: entry.total,
        nextOffset: end < entry.total ? end : null,
      }
    })
  }
  /** Retire readers before removing their files, including on Windows. */
  async forget(uri: string) {
    const entries = [...this.#entries].filter(([, entry]) => entry.uri === uri)
    for (const [id] of entries) this.#entries.delete(id)
    await Promise.all(
      entries.map(async ([, entry]) => {
        await this.#readers.retire(entry)
        await rm(entry.path, { force: true })
      }),
    )
  }
}
