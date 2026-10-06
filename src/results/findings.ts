import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { alive } from '../gridkit/runtime.js'
import { type EvidencePage, pageOf } from '../shared/inspection.js'
import { Readers } from './readers.js'

const PAGE = 256
interface Entry {
  uri: string
  summary: Record<string, unknown>
  path: string
  offsets: number[]
  total: number
  created: number
  owner: number
}
/** Immutable analysis rows live on disk. Paging them never rescans the result recording. */
export class Evidence {
  readonly #readers = new Readers<object>()
  readonly #entries = new Map<string, Entry>()
  readonly #writing = new Set<string>()
  constructor(readonly directory: string) {}
  #remember(id: string, entry: Entry) {
    this.#entries.delete(id)
    this.#entries.set(id, entry)
    for (const [key, old] of this.#entries) {
      if (this.#entries.size <= 64) break
      if (key !== id && !this.#readers.busy(old)) this.#entries.delete(key)
    }
  }
  async put(
    uri: string,
    result: { rows: unknown[] },
    signal: AbortSignal,
    id: string = randomUUID(),
  ) {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('Invalid analysis identifier.')
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, id + '.jsonl')
    const file = await open(path, 'wx')
    this.#writing.add(id)
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
      const entry = {
        uri,
        summary,
        path,
        offsets,
        total: result.rows.length,
        created: Date.now(),
        owner: process.pid,
      }
      const index = join(this.directory, id + '.json')
      await writeFile(index + '.tmp', JSON.stringify({ ...entry, path: undefined }))
      await rename(index + '.tmp', index)
      this.#remember(id, entry)
      return id
    } catch (error) {
      await file.close()
      await rm(path, { force: true })
      throw error
    } finally {
      await file.close()
      this.#writing.delete(id)
    }
  }
  async read(
    id: string,
    input: { offset?: number; limit?: number },
    signal: AbortSignal,
  ): Promise<EvidencePage> {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('Invalid analysis identifier.')
    let entry = this.#entries.get(id)
    if (!entry) {
      const saved = JSON.parse(
        await readFile(join(this.directory, id + '.json'), 'utf8').catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw Object.assign(
              new Error(
                'Analysis findings are no longer available. Analyze the retained simulation again.',
              ),
              { code: 'findings-evicted', analysisId: id },
            )
          throw error
        }),
      ) as Entry
      entry = { ...saved, path: join(this.directory, id + '.jsonl') }
    }
    this.#remember(id, entry)
    const found = entry
    return this.#readers.use([found], signal, async (signal) => {
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
            if (!bytesRead)
              throw new Error('Findings file is incomplete. Analyze the simulation again.')
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
  /** Old findings have their own bounded share of storage; active readers always keep their files. */
  async evict(budget: number, protectedId?: string): Promise<number> {
    const files = await readdir(this.directory).catch(() => [])
    const entries = await Promise.all(
      files
        .filter((name) => /^[\da-f-]{36}\.json$/i.test(name))
        .map(async (name) => {
          const id = name.slice(0, -5)
          const path = join(this.directory, id + '.jsonl')
          try {
            const entry =
              this.#entries.get(id) ??
              (JSON.parse(await readFile(join(this.directory, name), 'utf8')) as Entry)
            const bytes = (await stat(path)).size + (await stat(join(this.directory, name))).size
            return { id, entry, path, bytes }
          } catch {
            return undefined
          }
        }),
    )
    const retained = entries
      .filter((item) => item !== undefined)
      .sort((a, b) => a.entry.created - b.entry.created)
    let bytes = retained.reduce((sum, item) => sum + item.bytes, 0)
    for (const item of retained) {
      if (bytes <= budget) break
      if (item.id === protectedId || this.#writing.has(item.id) || this.#readers.busy(item.entry))
        continue
      if (item.entry.owner !== process.pid && alive(item.entry.owner)) continue
      await this.#readers.retire(item.entry)
      this.#entries.delete(item.id)
      await rm(item.path, { force: true })
      await rm(join(this.directory, item.id + '.json'), { force: true })
      bytes -= item.bytes
    }
    return bytes
  }
  /** Retire readers before removing their files, including on Windows. */
  async forget(uri: string) {
    const entries = [...this.#entries].filter(([, entry]) => entry.uri === uri)
    for (const [id] of entries) this.#entries.delete(id)
    await Promise.all(
      entries.map(async ([id, entry]) => {
        await this.#readers.retire(entry)
        await rm(entry.path, { force: true })
        await rm(join(this.directory, id + '.json'), { force: true })
      }),
    )
  }
}
