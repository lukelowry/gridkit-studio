import { copyFile, mkdir, open, rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'

import {
  appendData,
  bitAt,
  blockByteLength,
  type Data,
  type Domain,
  type Publication,
  type SampleBatch,
} from '@latkit/model'

import type { Case, Field } from '../gridkit/index.js'
import type { SimulationInfo } from '../shared/messages.js'
import { parseMessage } from './arrow.js'
import { columnName, type Layout, readResults, samplesOf } from './decode.js'

/** Copies of a publication's batches, whose arrays the decoder reuses: each view, not its buffer. */
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

/** The frame times of a page's batches: the coordinates of those of its first output. */
function timesOf(batches: readonly SampleBatch[]): number[] {
  const [first] = batches
  if (!first) return []
  const name = Object.keys(first.columns)[0]
  return batches
    .filter(
      (batch) => batch.index.type === first.index.type && Object.keys(batch.columns)[0] === name,
    )
    .flatMap((batch) => Array.from(batch.coordinates))
}

/** Frames `first` on, `count` of them, between bytes `start` and `end` of the results file. */
interface Page {
  start: number
  end: number
  first: number
  count: number
  domain: Domain
}

/** Decoded pages by key; past `limit` bytes, the least recently used are dropped. */
export class ResultCache {
  readonly #entries = new Map<string, { batches: readonly SampleBatch[]; bytes: number }>()
  bytes = 0
  constructor(public limit = 256 << 20) {}
  get(key: string) {
    const found = this.#entries.get(key)
    if (found) {
      this.#entries.delete(key)
      this.#entries.set(key, found)
    }
    return found?.batches
  }
  /** Copies of `publication`'s batches, whose arrays the caller may reuse once this returns; kept
   *  unless they alone exceed the limit. */
  put(key: string, publication: Publication) {
    const batches = ownedSamples(publication)
    const bytes = blockByteLength(batches)
    if (bytes > this.limit) return batches
    const old = this.#entries.get(key)
    if (old) this.bytes -= old.bytes
    this.#entries.delete(key)
    this.#entries.set(key, { batches, bytes })
    this.bytes += bytes
    while (this.bytes > this.limit) {
      const [key, entry] = this.#entries.entries().next().value!
      this.#entries.delete(key)
      this.bytes -= entry.bytes
    }
    return batches
  }
  drop(prefix: string) {
    for (const [key, entry] of this.#entries)
      if (key.startsWith(prefix)) {
        this.#entries.delete(key)
        this.bytes -= entry.bytes
      }
  }
}

/** A run's results: page offsets into its native file, decoded on demand. */
export class Results {
  readonly pages: Page[] = []
  #header = new Uint8Array()
  /** How every page of this run reads, from its header. */
  readonly #layout: Layout = {}
  #at = 0
  #last = -Infinity
  constructor(
    readonly info: SimulationInfo,
    readonly kase: Case,
    readonly fields: readonly Field[],
    readonly cache: ResultCache,
    readonly ownedDirectory?: string,
  ) {
    // A sibling contingency copies metadata, but must measure its own recording.
    this.info.domains = {}
  }

  async times(page: Page, signal: AbortSignal): Promise<number[]> {
    return timesOf(await this.#decode(page.start, page.end, page.first, signal))
  }

  /** Follows the results file as the run writes it, cutting it into pages and publishing each.
   *  Returns once `ended` and the file has nothing more. */
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
      // A wide run's frame is megabytes: reading in pieces that large keeps a frame from being
      // gathered from many small reads.
      const chunk = Buffer.alloc(4 << 20)
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
            if (pending.length < prefix + metadataLength) break
            const message = parseMessage(pending.subarray(prefix, prefix + metadataLength))
            const length = prefix + metadataLength + message.bodyLength
            if (!Number.isSafeInteger(message.bodyLength) || message.bodyLength < 0)
              throw new Error('An Arrow message has an invalid body length.')
            if (pending.length < length) break
            if (message.header.kind === 'schema') {
              if (this.#header.length) throw new Error('Repeated Arrow schema.')
              this.#header = pending.subarray(0, length).slice()
            } else if (message.header.kind === 'batch')
              await this.#append(
                start,
                start + length,
                signal,
                publish,
                pending.subarray(0, length),
              )
            start += length
            pending = pending.subarray(length)
          }
        } else {
          while (scan < pending.length) {
            // Only the header quotes; past it, a frame ends at its newline.
            if (this.#header.length) {
              const newline = pending.indexOf(10, scan)
              if (newline < 0) {
                scan = pending.length
                break
              }
              scan = newline + 1
            } else {
              const byte = pending[scan++]!
              if (byte === 34) quoted = !quoted
              if (byte !== 10 || quoted) continue
            }
            if (!this.#header.length) {
              this.#header = pending.subarray(0, scan).slice()
              start += scan
              pending = pending.subarray(scan)
              scan = 0
            } else if (++csvRows >= 64 || scan >= 4 << 20) {
              await this.#append(start, start + scan, signal, publish, pending.subarray(0, scan))
              start += scan
              pending = pending.subarray(scan)
              scan = 0
              csvRows = 0
            }
          }
          if (finished && pending.length) {
            await this.#append(start, start + pending.length, signal, publish, pending)
            pending = Buffer.alloc(0)
          }
        }
        if (finished) {
          if (pending.length) throw new Error('Results ended inside an Arrow message.')
          if (!this.#header.length) throw new Error('Results contain no header.')
          break
        }
        if (!bytesRead) await setTimeout(40, undefined, { signal })
      }
    } finally {
      await file.close()
    }
  }

  async pageData(p: number, signal: AbortSignal): Promise<Data> {
    return appendData(this.kase.data, await this.#page(p, signal))
  }

  /** The case's data with every page that overlaps `window` appended. */
  async data(window: Domain | undefined, signal: AbortSignal): Promise<Data> {
    let data = this.kase.data
    for (let p = 0; p < this.pages.length; p++) {
      const page = this.pages[p]!
      if (window && (page.domain[1] < window[0] || page.domain[0] > window[1])) continue
      signal.throwIfAborted()
      data = appendData(data, await this.#page(p, signal))
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
        ...this.fields.flatMap((field) => {
          const table = this.kase.table(field.index.type)
          return Array.from(field.rows, (row) => columnName(this.kase, table, row, field.name))
        }),
      ]
      await file.write(names.map((n) => '"' + n.replaceAll('"', '""') + '"').join(',') + '\n')
      for (const page of this.pages) {
        const batches = await this.#decode(page.start, page.end, page.first, signal)
        // Each tile of frames holds one batch per field.
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

  /** Drops the run's cached pages. */
  release() {
    this.cache.drop(this.info.id + ':')
  }

  /** Releases the run, and deletes its folder if it owns one under `scratchRoot`. */
  async dispose(scratchRoot: string) {
    this.release()
    if (this.ownedDirectory) {
      const target = resolve(this.ownedDirectory)
      const root = resolve(scratchRoot) + sep
      if (!target.startsWith(root)) throw new Error('Run cleanup escaped the scratch directory.')
      await rm(target, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  /** The frames between `start` and `end` of the file, the first of them frame `first`; `held` is
   *  those bytes when the caller has them already. */
  async #decode(
    start: number,
    end: number,
    first: number,
    signal: AbortSignal,
    held?: Uint8Array,
  ): Promise<SampleBatch[]> {
    const bytes = held ?? (await this.#read(start, end))
    const batches: SampleBatch[] = []
    await readResults(
      Readable.from([this.#header, bytes]),
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
      this.#layout,
    )
    return batches
  }

  async #read(start: number, end: number): Promise<Uint8Array> {
    const file = await open(this.info.path, 'r')
    try {
      const bytes = new Uint8Array(end - start)
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, start + read)
        if (!bytesRead) throw new Error('Result file changed while being read.')
        read += bytesRead
      }
      return bytes
    } finally {
      await file.close()
    }
  }

  /** Decodes the page between `start` and `end`, caches it, and publishes it. */
  async #append(
    start: number,
    end: number,
    signal: AbortSignal,
    publish: (batches: Publication) => Promise<void>,
    held?: Uint8Array,
  ) {
    const batches = await this.#decode(start, end, this.info.frames, signal, held)
    const coordinates = timesOf(batches)
    if (!coordinates.length) return
    const low = coordinates[0]!
    const high = coordinates.at(-1)!
    if (low < this.#last) throw new Error('Result times must be nondecreasing.')
    this.#last = high
    const count = coordinates.length
    const page = { start, end, first: this.info.frames, count, domain: [low, high] as Domain }
    const owned = this.cache.put(this.#key(this.pages.length), batches)
    // Measure once on ingestion, before eviction or view windowing. Every view uses these
    // same ranges; scrubbing never rescans history or normalizes an individual frame.
    const domains = (this.info.domains ??= {})
    for (const batch of batches) {
      const fields = (domains[batch.index.type] ??= {})
      const rows = batch.rows.kind === 'range' ? batch.rows.count : batch.rows.values.length
      for (const [name, column] of Object.entries(batch.columns)) {
        let [min, max] = fields[name] ?? [Infinity, -Infinity]
        for (let frame = 0; frame < batch.coordinates.length; frame++)
          for (let row = 0; row < rows; row++) {
            const at = column.offset + frame * column.frameStride + row * column.rowStride
            const value = column.values[at]!
            if (!bitAt(column.validity, at) || !Number.isFinite(value)) continue
            min = Math.min(min, value)
            max = Math.max(max, value)
          }
        if (min <= max) fields[name] = [min, max]
      }
    }
    this.pages.push(page)
    this.info.frames += count
    this.info.domain = [this.pages[0]!.domain[0], high]
    await publish(owned)
  }

  /** Page `p`'s batches, from the cache, or decoded again into it. */
  async #page(p: number, signal: AbortSignal): Promise<readonly SampleBatch[]> {
    const page = this.pages[p]!
    const key = this.#key(p)
    return (
      this.cache.get(key) ??
      this.cache.put(key, await this.#decode(page.start, page.end, page.first, signal))
    )
  }

  #key(p: number): string {
    return this.info.id + ':' + p
  }
}
