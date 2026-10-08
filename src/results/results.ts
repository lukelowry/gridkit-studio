import { randomUUID } from 'node:crypto'
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
import { pageWindow } from '../shared/coverage.js'
import type { SimulationInfo } from '../shared/messages.js'
import { parseMessage } from './arrow.js'
import { csvTimes } from './csv.js'
import { columnName, type Layout, readResults, samplesOf } from './decode.js'
import { PAGE_BYTES, PROGRESS_MS } from './limits.js'

/** The frame times of a page's batches: the coordinates of those of its first output. */
function timesOf(batches: readonly SampleBatch[]): Float64Array {
  const [first] = batches
  if (!first) return new Float64Array()
  const name = Object.keys(first.columns)[0]
  const parts = batches.filter(
    (batch) => batch.index.type === first.index.type && Object.keys(batch.columns)[0] === name,
  )
  const times = new Float64Array(
    parts.reduce((count, batch) => count + batch.coordinates.length, 0),
  )
  let at = 0
  for (const batch of parts) {
    times.set(batch.coordinates, at)
    at += batch.coordinates.length
  }
  return times
}

/** The first of `count` indices where `holds`, which holds at every index after one it holds at;
 *  `count` when it holds at none. */
function firstWhere(count: number, holds: (index: number) => boolean): number {
  let low = 0
  let high = count
  while (low < high) {
    const middle = (low + high) >>> 1
    if (holds(middle)) high = middle
    else low = middle + 1
  }
  return low
}

/** Frames `first` on, `count` of them at `times`, between bytes `start` and `end` of the results
 *  file. */
interface Page {
  start: number
  end: number
  first: number
  count: number
  domain: Domain
  times: Float64Array
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
  /** Keeps `batches` themselves, whose arrays nothing writes again, unless they alone exceed the
   *  limit; returns them either way. */
  put(key: string, batches: readonly SampleBatch[]) {
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
  /** Names how this reading cuts the run into pages. Another reading of the same run, as after it
   *  is loaded again from its file, may cut it elsewhere; its pages only ever grow. */
  readonly paging = randomUUID()
  /** The header's bytes: the CSV header line, or the Arrow schema message. */
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

  /** Follows the results file as the run writes it, cutting it into pages and publishing each.
   *  Returns once `ended` and the file has nothing more. */
  async ingest(
    signal: AbortSignal,
    ended: () => boolean,
    publish: (batches: Publication) => Promise<void>,
  ) {
    await this.#follow(signal, ended, (start, end, bytes) =>
      this.#append(start, end, bytes, signal, publish),
    )
  }

  /** Pages a finished results file as `ingest` would, but measures nothing: for a run whose domains
   *  were measured as it ran. A CSV page is read only as far as each row's time, and decoded once
   *  something asks for it. */
  async index(signal: AbortSignal) {
    await this.#follow(
      signal,
      () => true,
      async (start, end, bytes) => {
        const times =
          this.info.format === 'csv'
            ? csvTimes(bytes)
            : timesOf(await this.#decode(bytes, this.info.frames, signal))
        if (times.length) this.#add(start, end, times)
      },
    )
  }

  /** The first frame time after `at`, or the last before it when `direction` is -1, from the pages'
   *  times alone: the run's last or first time when there is none. */
  step(at: number, direction: -1 | 1): number {
    const pages = this.pages
    if (direction > 0) {
      const p = firstWhere(pages.length, (p) => pages[p]!.domain[1] > at)
      if (p === pages.length) return this.info.domain[1]
      const times = pages[p]!.times
      return times[firstWhere(times.length, (t) => times[t]! > at)]!
    }
    const p = firstWhere(pages.length, (p) => pages[p]!.domain[0] >= at) - 1
    if (p < 0) return this.info.domain[0]
    const times = pages[p]!.times
    return times[firstWhere(times.length, (t) => times[t]! >= at) - 1]!
  }

  async pageData(p: number, signal: AbortSignal): Promise<Data> {
    return appendData(this.kase.data, await this.#page(p, signal))
  }

  /** The case's data with every page that overlaps `window` appended. */
  async data(window: Domain | undefined, signal: AbortSignal): Promise<Data> {
    let data = this.kase.data
    const [first, end] = pageWindow(this.pages, window)
    for (let p = first; p < end; p++) {
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
        const batches = await this.#decode(
          await this.#read(page.start, page.end),
          page.first,
          signal,
        )
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

  /** Follows the results file until `ended` and it has nothing more, handing `page` each page of it:
   *  the bytes between `start` and `end` of the file. A CSV page ends at the first row end past
   *  PAGE_BYTES. While the run writes, one also ends at the last whole row read each time the
   *  views would take a page, so a live run's pages come at its pace and a finished file's are
   *  large. */
  async #follow(
    signal: AbortSignal,
    ended: () => boolean,
    page: (start: number, end: number, bytes: Uint8Array) => Promise<void>,
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
      /** Where the search for the end of the CSV header, or of a page, resumes in `pending`. */
      let scan = 0
      let quoted = false
      /** When the last page was cut. The first is cut as soon as it can be. */
      let cutAt = -Infinity
      const cut = async (length: number) => {
        await page(start, start + length, pending.subarray(0, length))
        start += length
        pending = pending.subarray(length)
        scan = 0
        cutAt = performance.now()
      }
      // A wide run's frame is megabytes: reading in pieces that large keeps a frame from being
      // gathered from many small reads.
      const chunk = Buffer.alloc(4 << 20)
      while (true) {
        signal.throwIfAborted()
        // Asked before reading: a writer done by then has written everything this read can see.
        const over = ended()
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.#at)
        if (bytesRead) {
          this.#at += bytesRead
          pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        }
        const finished = over && bytesRead === 0
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
            if (message.header.kind === 'batch') {
              await cut(length)
              continue
            }
            if (message.header.kind === 'schema') {
              if (this.#header.length) throw new Error('Repeated Arrow schema.')
              this.#header = pending.subarray(0, length).slice()
            }
            start += length
            pending = pending.subarray(length)
          }
        } else {
          // Only the header quotes; past it, a row ends at its newline.
          while (!this.#header.length && scan < pending.length) {
            const byte = pending[scan++]!
            if (byte === 34) quoted = !quoted
            if (byte !== 10 || quoted) continue
            this.#header = pending.subarray(0, scan).slice()
            // Read alone, the header gives the layout every page is read with.
            await readResults(
              Readable.from([this.#header]),
              this.fields,
              this.kase,
              { signal, publish: () => {} },
              'csv',
              this.#layout,
            )
            start += scan
            pending = pending.subarray(scan)
            scan = 0
          }
          if (this.#header.length) {
            while (pending.length >= PAGE_BYTES) {
              const newline = pending.indexOf(10, Math.max(scan, PAGE_BYTES - 1))
              if (newline < 0) {
                scan = pending.length
                break
              }
              await cut(newline + 1)
            }
            // Once the writer is done, everything it wrote is a page. Before, the whole rows read so
            // far are, whenever the views would next take one.
            const length = finished
              ? pending.length
              : !over && performance.now() - cutAt >= PROGRESS_MS
                ? pending.lastIndexOf(10) + 1
                : 0
            if (length) await cut(length)
          }
        }
        if (finished) {
          if (this.info.format === 'arrow' && pending.length)
            throw new Error('Results ended inside an Arrow message.')
          if (!this.#header.length) throw new Error('Results contain no header.')
          break
        }
        if (!bytesRead) await setTimeout(40, undefined, { signal })
      }
    } finally {
      await file.close()
    }
  }

  /** The frames in `bytes`, the first of them frame `first`. A CSV page is rows alone, read with the
   *  layout its header gave; an Arrow batch is read after the schema. */
  async #decode(bytes: Uint8Array, first: number, signal: AbortSignal): Promise<SampleBatch[]> {
    const batches: SampleBatch[] = []
    await readResults(
      Readable.from(this.info.format === 'csv' ? [bytes] : [this.#header, bytes]),
      this.fields,
      this.kase,
      {
        signal,
        publish: (frames) => {
          batches.push(
            ...samplesOf(this.fields, { ...frames, firstFrame: frames.firstFrame + first }),
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

  /** Decodes the page between `start` and `end`, `bytes`, caches it and publishes it. */
  async #append(
    start: number,
    end: number,
    bytes: Uint8Array,
    signal: AbortSignal,
    publish: (batches: Publication) => Promise<void>,
  ) {
    const batches = await this.#decode(bytes, this.info.frames, signal)
    const times = timesOf(batches)
    if (!times.length) return
    const p = this.#add(start, end, times)
    // The cache keeps the very batches published: a page is decoded once.
    this.cache.put(this.#key(p), batches)
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
    await publish(batches)
  }

  /** Adds the page between `start` and `end` whose frames are at `times`, and returns its number. */
  #add(start: number, end: number, times: Float64Array): number {
    for (const time of times) {
      if (time < this.#last) throw new Error('Result times must be nondecreasing.')
      this.#last = time
    }
    const domain: Domain = [times[0]!, times.at(-1)!]
    this.pages.push({ start, end, first: this.info.frames, count: times.length, domain, times })
    this.info.frames += times.length
    this.info.domain = [this.pages[0]!.domain[0], domain[1]]
    return this.pages.length - 1
  }

  /** Page `p`'s batches, from the cache, or decoded again into it. */
  async #page(p: number, signal: AbortSignal): Promise<readonly SampleBatch[]> {
    const page = this.pages[p]!
    const key = this.#key(p)
    return (
      this.cache.get(key) ??
      this.cache.put(
        key,
        await this.#decode(await this.#read(page.start, page.end), page.first, signal),
      )
    )
  }

  #key(p: number): string {
    return this.info.id + ':' + p
  }
}
