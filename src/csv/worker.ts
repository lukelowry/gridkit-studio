import { type FileHandle, open } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { parentPort, workerData } from 'node:worker_threads'

import { serve, transferred } from '@latkit/port'

import { SharedCache } from '../cache.js'
import { serveTableWorker } from '../table/worker-service.js'
import { decoder, header, lines } from './decode.js'
import { workerPort } from './port.js'
import { type CsvInfo, csvProtocol, type Query, type Samples } from './protocol.js'
export type { CsvInfo, Samples } from './protocol.js'

export class CsvFile {
  private file?: FileHandle
  private offset = 0
  private info: CsvInfo = { headers: [], rows: 0, range: null, bytes: 0, indexEntries: 0 }
  private index: { offset: number; time: number; frame: number }[] = []
  private stride = 256
  private readonly extents = new Map<string, { frame: number; min: number; max: number }>()
  private readonly frames: SharedCache<Samples>
  constructor(
    private readonly path: string,
    private readonly frameBudget = 32 * 1024 * 1024,
  ) {
    this.frames = new SharedCache(
      frameBudget,
      (sample) => sample.values.byteLength + sample.time.byteLength,
    )
  }
  /** Cache decoded committed frames below all consumers; returned projections are owned copies. */
  private async frame(index: number, signal?: AbortSignal): Promise<Samples> {
    return this.frames.get(
      String(index),
      async (abort) => {
        const start = this.start(index, 'frame')
        if (!this.file || !start) throw new Error('No CSV samples are available yet.')
        let frame = start.frame
        const end = this.offset
        for await (const row of lines(this.file, start.offset, end, true, abort)) {
          if (!row.text) continue
          if (frame++ === index) {
            const sample = decoder(this.info.headers.length, null)(row.text)
            return { time: Float64Array.of(sample.time), values: sample.values }
          }
        }
        throw new Error('CSV changed during the read.')
      },
      signal,
    )
  }
  async scan(final: boolean, signal?: AbortSignal): Promise<CsvInfo> {
    signal?.throwIfAborted()
    this.file ??= await open(this.path, 'r')
    const stat = await this.file.stat()
    if (stat.size < this.offset)
      throw new Error('The CSV was truncated while it was being read. Run the solver again.')
    let decode = decoder(this.info.headers.length, [])
    for await (const row of lines(this.file, this.offset, stat.size, final, signal)) {
      if (!this.info.headers.length) {
        this.info.headers = header(row.text)
        decode = decoder(this.info.headers.length, [])
      } else if (row.text) {
        const { time } = decode(row.text)
        if (this.info.range && time < this.info.range[1])
          throw new Error('CSV time decreases; samples must be ordered by time.')
        this.info.range = [this.info.range?.[0] ?? time, time]
        if (this.info.rows % this.stride === 0) {
          this.index.push({ offset: row.offset, time, frame: this.info.rows })
          if (this.index.length > 8192) {
            this.index = this.index.filter((_, i) => i % 2 === 0)
            this.stride *= 2
          }
        }
        this.info.rows++
        if (this.info.rows % 1024 === 0) {
          await setImmediate()
          signal?.throwIfAborted()
        }
      }
      this.offset = row.end
    }
    return { ...this.info, bytes: this.offset, indexEntries: this.index.length }
  }
  private start(value: number, key: 'time' | 'frame') {
    let low = 0
    let high = this.index.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (this.index[mid][key] <= value) low = mid + 1
      else high = mid
    }
    return this.index[Math.max(0, low - 1)]
  }
  async locate(time: number, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted()
    if (!Number.isFinite(time)) throw new Error('Invalid timeline time.')
    const start = this.start(time, 'time')
    if (!this.file || !start) return -1
    const decode = decoder(this.info.headers.length, [])
    let frame = start.frame
    let found = -1
    for await (const row of lines(this.file, start.offset, this.offset, true, signal)) {
      if (!row.text) continue
      if (decode(row.text).time > time) break
      found = frame++
      if (frame % 1024 === 0) {
        await setImmediate()
        signal?.throwIfAborted()
      }
    }
    return found
  }
  /** Bounds include every repeated timestamp and honor the caller's committed head. */
  async bounds(
    range: readonly [number, number],
    frameCount: number,
    signal?: AbortSignal,
  ): Promise<readonly [number, number]> {
    signal?.throwIfAborted()
    if (
      !range.every(Number.isFinite) ||
      range[0] > range[1] ||
      !Number.isSafeInteger(frameCount) ||
      frameCount < 0 ||
      frameCount > this.info.rows
    )
      throw new RangeError('Invalid time bounds.')
    if (!frameCount || !this.file) return [0, 0]
    const bound = async (time: number, upper: boolean): Promise<number> => {
      let low = 0
      let high = this.index.length
      while (low < high) {
        const mid = low + Math.floor((high - low) / 2)
        if (
          this.index[mid].frame < frameCount &&
          (this.index[mid].time < time || (upper && this.index[mid].time === time))
        )
          low = mid + 1
        else high = mid
      }
      const start = this.index[Math.max(0, low - 1)]
      const decode = decoder(this.info.headers.length, [])
      let frame = start.frame
      for await (const row of lines(this.file!, start.offset, this.offset, true, signal)) {
        if (!row.text) continue
        if (frame >= frameCount) break
        const value = decode(row.text).time
        if (value > time || (!upper && value === time)) return frame
        frame++
        if (frame % 1024 === 0) {
          await setImmediate()
          signal?.throwIfAborted()
        }
      }
      return frameCount
    }
    return [await bound(range[0], false), await bound(range[1], true)]
  }
  async extent(
    columns: readonly number[],
    signal?: AbortSignal,
  ): Promise<readonly [number, number]> {
    signal?.throwIfAborted()
    if (
      columns.some(
        (column) =>
          !Number.isSafeInteger(column) || column <= 0 || column >= this.info.headers.length,
      )
    )
      throw new Error('Invalid signal columns.')
    const key = columns.join(',')
    const extent = this.extents.get(key) ?? { frame: 0, min: Infinity, max: -Infinity }
    this.extents.set(key, extent)
    const start = this.start(extent.frame, 'frame')
    if (this.file && start && extent.frame < this.info.rows) {
      const decode = decoder(this.info.headers.length, columns)
      let frame = start.frame
      for await (const row of lines(this.file, start.offset, this.offset, true, signal)) {
        if (!row.text) continue
        if (frame >= extent.frame) {
          for (const value of decode(row.text).values)
            if (Number.isFinite(value)) {
              extent.min = Math.min(extent.min, value)
              extent.max = Math.max(extent.max, value)
            }
          extent.frame = frame + 1
        }
        if (++frame % 256 === 0) {
          await setImmediate()
          signal?.throwIfAborted()
        }
      }
    }
    return extent.min === Infinity ? [0, 1] : [extent.min, extent.max]
  }
  async read(
    frameOffset: number,
    frameCount: number,
    columns: readonly number[],
    signal?: AbortSignal,
  ): Promise<Samples> {
    signal?.throwIfAborted()
    if (
      ![frameOffset, frameCount].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      frameOffset + frameCount > this.info.rows ||
      columns.some(
        (c) => !Number.isInteger(c) || c < -1 || c === 0 || c >= this.info.headers.length,
      )
    )
      throw new Error('Invalid CSV block.')
    if (frameCount === 1 && this.info.headers.length * 8 <= this.frameBudget) {
      const sample = await this.frame(frameOffset, signal)
      signal?.throwIfAborted()
      return {
        time: sample.time.slice(),
        values: Float64Array.from(columns, (column) =>
          column < 0 ? NaN : sample.values[column - 1],
        ),
      }
    }
    const time = new Float64Array(frameCount)
    const values = new Float64Array(frameCount * columns.length).fill(NaN)
    const start = this.start(frameOffset, 'frame')
    if (!frameCount) return { time, values }
    if (!this.file || !start) throw new Error('No CSV samples are available yet.')
    const decode = decoder(this.info.headers.length, columns)
    let frame = start.frame
    for await (const row of lines(this.file, start.offset, this.offset, true, signal)) {
      if (!row.text) continue
      if (frame >= frameOffset) {
        const sample = decode(row.text)
        const at = frame - frameOffset
        time[at] = sample.time
        values.set(sample.values, at * columns.length)
      }
      if (++frame >= frameOffset + frameCount) break
      if (frame % 1024 === 0) {
        await setImmediate()
        signal?.throwIfAborted()
      }
    }
    if (frame < frameOffset + frameCount) throw new Error('CSV changed during the read.')
    return { time, values }
  }
  async dispose() {
    this.frames.clear()
    await this.file?.close()
    this.file = undefined
    this.index = []
  }
}
if (parentPort) {
  const file = new CsvFile(workerData.path)
  serveTableWorker(workerPort(parentPort), file)
  let pending: Promise<unknown> = Promise.resolve()
  serve(
    workerPort(parentPort),
    csvProtocol,
    (query: Query, signal) => {
      const next = pending.then(async () => {
        signal.throwIfAborted()
        if (query.type === 'extent') return file.extent(query.columns, signal)
        if (query.type === 'scan') return file.scan(query.final, signal)
        if (query.type === 'bounds') return file.bounds(query.range, query.frameCount, signal)
        if (query.type === 'locate') return file.locate(query.time, signal)
        const value = await file.read(query.frameOffset, query.frameCount, query.columns, signal)
        return transferred(value, [
          value.time.buffer as ArrayBuffer,
          value.values.buffer as ArrayBuffer,
        ])
      })
      pending = next.catch(() => {})
      return next
    },
    {
      onClose: () => {
        void pending.finally(() => file.dispose())
      },
    },
  )
}
