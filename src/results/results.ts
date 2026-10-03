import { copyFile, mkdir, open, rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'

import {
  appendData,
  blockByteLength,
  type Data,
  type Domain,
  type Publication,
  type SampleBatch,
} from '@latkit/model'

import type { Case } from '../gridkit/case.js'
import type { Field } from '../gridkit/parameters.js'
import type { RunInfo } from '../messages.js'
import { parseMessage } from './arrow.js'
import { readResults, samplesOf } from './decode.js'

/** Decoder arrays are borrowed and reused. Copy only exposed views, never their backing allocations. */
function ownedSamples(publication: Publication): SampleBatch[] {
  const coordinates = new Map<Float64Array, Float64Array>()
  return publication.map((batch) => {
    if (batch.kind !== 'samples')
      throw new Error('A result publication must contain sampled observations.')
    let times = coordinates.get(batch.coordinates)
    if (!times) {
      times = batch.coordinates.slice()
      coordinates.set(batch.coordinates, times)
    }
    return {
      ...batch,
      coordinates: times,
      rows:
        batch.rows.kind === 'indices'
          ? { ...batch.rows, values: batch.rows.values.slice() }
          : batch.rows,
      columns: Object.fromEntries(
        Object.entries(batch.columns).map(([name, column]) => [
          name,
          {
            ...column,
            values: column.values.slice(),
            ...(column.validity ? { validity: column.validity.slice() } : {}),
          },
        ]),
      ),
    }
  })
}
interface Page {
  start: number
  end: number
  first: number
  count: number
  domain: Domain
}
export class ResultCache {
  readonly entries = new Map<string, { batches: readonly SampleBatch[]; bytes: number }>()
  bytes = 0
  constructor(public limit = 256 << 20) {}
  get(key: string) {
    const found = this.entries.get(key)
    if (found) {
      this.entries.delete(key)
      this.entries.set(key, found)
    }
    return found?.batches
  }
  put(key: string, publication: Publication) {
    // Take ownership before publication resolves; callers may immediately reuse their arrays.
    const batches = ownedSamples(publication)
    const bytes = blockByteLength(batches)
    if (bytes > this.limit) return batches
    const old = this.entries.get(key)
    if (old) this.bytes -= old.bytes
    this.entries.delete(key)
    this.entries.set(key, { batches, bytes })
    this.bytes += bytes
    while (this.bytes > this.limit) {
      const [key, entry] = this.entries.entries().next().value!
      this.entries.delete(key)
      this.bytes -= entry.bytes
    }
    return batches
  }
  drop(prefix: string) {
    for (const [key, entry] of this.entries)
      if (key.startsWith(prefix)) {
        this.entries.delete(key)
        this.bytes -= entry.bytes
      }
  }
}
/** Sparse native-file offsets, with raw output as durable backing. No second archive format. */
export class Results {
  readonly pages: Page[] = []
  header = new Uint8Array()
  #at = 0
  #last = -Infinity
  constructor(
    readonly info: RunInfo,
    readonly kase: Case,
    readonly fields: readonly Field[],
    readonly cache: ResultCache,
    readonly ownedDirectory?: string,
  ) {}
  async decode(
    start: number,
    end: number,
    first: number,
    signal: AbortSignal,
  ): Promise<SampleBatch[]> {
    const file = await open(this.info.path, 'r')
    try {
      const bytes = new Uint8Array(end - start)
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, start + read)
        if (!bytesRead) throw new Error('Result file changed while being read.')
        read += bytesRead
      }
      const batches: SampleBatch[] = []
      await readResults(
        Readable.from([this.header, bytes]),
        this.fields,
        this.kase,
        {
          signal,
          publish: (frames) => {
            batches.push(
              ...ownedSamples(
                samplesOf(this.fields, { ...frames, firstFrame: frames.firstFrame + first }),
              ),
            )
          },
        },
        this.info.format,
      )
      return batches
    } finally {
      await file.close()
    }
  }
  async append(
    start: number,
    end: number,
    signal: AbortSignal,
    publish: (batches: Publication) => Promise<void>,
  ) {
    const batches = await this.decode(start, end, this.info.frames, signal)
    const coordinates = batches
      .filter(
        (b) =>
          b.index.type === batches[0]?.index.type &&
          Object.keys(b.columns)[0] === Object.keys(batches[0]?.columns ?? {})[0],
      )
      .flatMap((b) => Array.from(b.coordinates))
    if (!coordinates.length) return
    const low = coordinates[0]!
    const high = coordinates.at(-1)!
    if (low < this.#last) throw new Error('Result times must be nondecreasing.')
    this.#last = high
    const count = coordinates.length
    const page = { start, end, first: this.info.frames, count, domain: [low, high] as Domain }
    const owned = this.cache.put(this.info.id + ':' + this.pages.length, batches)
    this.pages.push(page)
    this.info.frames += count
    this.info.domain = [this.pages[0]!.domain[0], high]
    await publish(owned)
  }
  async ingest(
    signal: AbortSignal,
    ended: () => boolean,
    publish: (batches: Publication) => Promise<void>,
  ) {
    let file
    while (!file) {
      signal.throwIfAborted()
      try {
        file = await open(this.info.path, 'r')
      } catch (error) {
        if (ended()) throw error
        await setTimeout(40, undefined, { signal })
      }
    }
    try {
      let pending = Buffer.alloc(0)
      let start = this.#at
      let csvRows = 0
      let scan = 0
      let quoted = false
      const chunk = Buffer.alloc(256 << 10)
      while (true) {
        signal.throwIfAborted()
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.#at)
        if (bytesRead) {
          this.#at += bytesRead
          pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        }
        const finished = ended() && bytesRead === 0
        if (this.info.format === 'arrow') {
          while (pending.length >= 8) {
            const continuation = pending.readUInt32LE(0) === 0xffffffff
            const prefix = continuation ? 8 : 4
            const metadataLength = pending.readUInt32LE(continuation ? 4 : 0)
            if (!metadataLength) {
              start += prefix
              pending = pending.subarray(prefix)
              break
            }
            if (metadataLength > 32 << 20) throw new Error('Arrow metadata exceeds 32 MiB.')
            if (pending.length < prefix + metadataLength) break
            const message = parseMessage(pending.subarray(prefix, prefix + metadataLength))
            const length = prefix + metadataLength + message.bodyLength
            if (length > 32 << 20 || message.bodyLength < 0)
              throw new Error('Arrow batch exceeds 32 MiB.')
            if (pending.length < length) break
            if (message.header.kind === 'schema') {
              if (this.header.length) throw new Error('Repeated Arrow schema.')
              this.header = pending.subarray(0, length).slice()
            } else if (message.header.kind === 'batch')
              await this.append(start, start + length, signal, publish)
            start += length
            pending = pending.subarray(length)
          }
        } else {
          while (scan < pending.length) {
            const byte = pending[scan++]!
            if (!this.header.length && byte === 34) quoted = !quoted
            if (byte !== 10 || quoted) continue
            if (!this.header.length) {
              this.header = pending.subarray(0, scan).slice()
              start += scan
              pending = pending.subarray(scan)
              scan = 0
            } else if (++csvRows >= 64 || scan >= 4 << 20) {
              await this.append(start, start + scan, signal, publish)
              start += scan
              pending = pending.subarray(scan)
              scan = 0
              csvRows = 0
            }
          }
          if (finished && pending.length) {
            await this.append(start, start + pending.length, signal, publish)
            pending = Buffer.alloc(0)
          }
        }
        if (pending.length > 32 << 20) throw new Error('Result record exceeds 32 MiB.')
        if (finished) {
          if (pending.length) throw new Error('Results ended inside an Arrow message.')
          if (!this.header.length) throw new Error('Results contain no header.')
          break
        }
        if (!bytesRead) await setTimeout(40, undefined, { signal })
      }
    } finally {
      await file.close()
    }
  }
  async pageData(p: number, signal: AbortSignal): Promise<Data> {
    const page = this.pages[p]!
    const key = this.info.id + ':' + p
    const batches =
      this.cache.get(key) ??
      this.cache.put(key, await this.decode(page.start, page.end, page.first, signal))
    return appendData(this.kase.data, batches)
  }
  async data(window: Domain | undefined, signal: AbortSignal): Promise<Data> {
    let data = this.kase.data
    let bytes = 0
    for (let p = 0; p < this.pages.length; p++) {
      const page = this.pages[p]!
      if (window && (page.domain[1] < window[0] || page.domain[0] > window[1])) continue
      signal.throwIfAborted()
      const key = this.info.id + ':' + p
      const batches =
        this.cache.get(key) ??
        this.cache.put(key, await this.decode(page.start, page.end, page.first, signal))
      bytes += blockByteLength(batches)
      if (bytes > this.cache.limit)
        throw new Error('Query exceeds the sample memory budget; narrow its window.')
      data = appendData(data, batches)
    }
    return data
  }
  async exportCsv(path: string, signal: AbortSignal) {
    if (resolve(path) === resolve(this.info.path))
      throw new Error('Choose a different file from the open run.')
    await mkdir(dirname(path), { recursive: true })
    if (this.info.format === 'csv') return copyFile(this.info.path, path)
    const file = await open(path, 'w')
    try {
      const names = [
        'time',
        ...this.fields.flatMap((field) =>
          Array.from(field.rows, (row) => {
            const table = this.kase.table(field.index.type)
            return `${table.shape.type}_${table.shape.kind === 'bus' ? this.kase.cell(table, 'name', row) : this.kase.native(table, row)}_${field.name}`
          }),
        ),
      ]
      await file.write(names.map((n) => '"' + n.replaceAll('"', '""') + '"').join(',') + '\n')
      for (const page of this.pages) {
        const batches = await this.decode(page.start, page.end, page.first, signal)
        // Decoder publications contain one batch per field for each common frame tile.
        for (let at = 0; at < batches.length; at += this.fields.length) {
          const tile = batches.slice(at, at + this.fields.length)
          const first = tile[0]!
          for (let t = 0; t < first.coordinates.length; t++) {
            const values = tile.flatMap((batch) =>
              Object.values(batch.columns).flatMap((column) => {
                const width =
                  batch.rows.kind === 'range' ? batch.rows.count : batch.rows.values.length
                return Array.from(
                  { length: width },
                  (_, r) =>
                    column.values[column.offset + t * column.frameStride + r * column.rowStride]!,
                )
              }),
            )
            await file.write([first.coordinates[t], ...values].join(',') + '\n')
          }
        }
      }
    } finally {
      await file.close()
    }
  }
  async dispose(scratchRoot: string) {
    this.cache.drop(this.info.id + ':')
    if (this.ownedDirectory) {
      const target = resolve(this.ownedDirectory)
      const root = resolve(scratchRoot) + sep
      if (!target.startsWith(root)) throw new Error('Run cleanup escaped the scratch directory.')
      await rm(target, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}
