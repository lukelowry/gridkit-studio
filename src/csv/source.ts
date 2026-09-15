import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { fieldKey, type FieldRef } from '@latkit/model'
import type { MonitorSource, SourceWindow } from '@latkit/monitor'
import { connect } from '@latkit/port'

import type { CsvColumn } from './columns.js'
import { workerPort } from './port.js'
import { type CsvInfo, csvProtocol, type Samples } from './protocol.js'
export type { CsvInfo, Samples } from './protocol.js'
const BLOCK_BYTES = 1024 * 1024
const CACHE_BYTES = 16 * 1024 * 1024

export class CsvSource {
  readonly id = randomUUID()
  private readonly worker: Worker
  private readonly connection
  private bindings: readonly CsvColumn[] = []
  private readonly fieldRefs = new Map<string, FieldRef>()
  private readonly byField = new Map<string, Map<number, number>>()
  private readonly cache = new Map<string, Samples>()
  private cacheBytes = 0
  private position?: { time: number; rows: number; frame: number }
  info?: CsvInfo
  constructor(
    readonly path: string,
    workerPath = join(__dirname, 'csv/worker.cjs'),
  ) {
    this.worker = new Worker(workerPath, { workerData: { path } })
    this.connection = connect(workerPort(this.worker), csvProtocol)
  }
  get fields(): readonly FieldRef[] {
    return [...this.fieldRefs.values()]
  }
  get columns(): readonly CsvColumn[] {
    return this.bindings
  }
  set columns(columns: readonly CsvColumn[]) {
    this.bindings = columns
    this.byField.clear()
    this.fieldRefs.clear()
    for (const column of columns) {
      const key = fieldKey(column.field)
      this.fieldRefs.set(key, column.field)
      const map = this.byField.get(key) ?? new Map<number, number>()
      map.set(column.element, column.column)
      this.byField.set(key, map)
    }
  }
  async scan(final = false, signal?: AbortSignal): Promise<CsvInfo> {
    return (this.info = (await this.connection.call(
      { type: 'scan', final },
      { signal },
    )) as CsvInfo)
  }
  has(field: FieldRef, element?: number): boolean {
    const map = this.byField.get(fieldKey(field))
    return !!map && (element === undefined || map.has(element))
  }
  recordedCount(field: FieldRef, element?: number): number {
    const members = this.byField.get(fieldKey(field))
    return element === undefined ? (members?.size ?? 0) : Number(members?.has(element) ?? false)
  }
  async locate(time: number, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted()
    if (this.position?.time === time && this.position.rows === this.info?.rows)
      return this.position.frame
    const rows = this.info?.rows ?? 0
    const frame = (await this.connection.call({ type: 'locate', time }, { signal })) as number
    this.position = { time, rows, frame }
    return frame
  }
  async extent(field: FieldRef, signal?: AbortSignal): Promise<readonly [number, number]> {
    const columns = [...(this.byField.get(fieldKey(field))?.values() ?? [])]
    if (!columns.length) return [0, 1]
    return (await this.connection.call({ type: 'extent', columns }, { signal })) as readonly [
      number,
      number,
    ]
  }
  async timeAt(frame: number, signal?: AbortSignal): Promise<number> {
    return (await this.read(frame, 1, [], signal)).time[0]
  }
  private async read(
    frameOffset: number,
    frameCount: number,
    columns: readonly number[],
    signal?: AbortSignal,
  ): Promise<Samples> {
    signal?.throwIfAborted()
    const key = `${frameOffset}:${frameCount}:${columns.join(',')}`
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    const result = (await this.connection.call(
      { type: 'read', frameOffset, frameCount, columns },
      { signal },
    )) as Samples
    const bytes = result.time.byteLength + result.values.byteLength
    if (bytes <= CACHE_BYTES && !this.cache.has(key)) {
      while (this.cacheBytes + bytes > CACHE_BYTES && this.cache.size) {
        const [old, value] = this.cache.entries().next().value!
        this.cache.delete(old)
        this.cacheBytes -= value.time.byteLength + value.values.byteLength
      }
      this.cache.set(key, result)
      this.cacheBytes += bytes
    }
    return result
  }
  async cellsAt(
    frame: number,
    fields: readonly FieldRef[],
    elements: readonly number[],
    signal?: AbortSignal,
  ): Promise<Float64Array> {
    const values = new Float64Array(fields.length * elements.length).fill(NaN)
    if (frame < 0) return values
    const maps = fields.map((field) => this.byField.get(fieldKey(field)))
    const chunk = Math.max(1, Math.floor(BLOCK_BYTES / 8))
    for (let offset = 0; offset < values.length; offset += chunk) {
      const count = Math.min(chunk, values.length - offset)
      const columns = Array.from({ length: count }, (_, i) => {
        const at = offset + i
        return maps[at % fields.length]?.get(elements[Math.floor(at / fields.length)]) ?? -1
      })
      const result = await this.read(frame, 1, columns, signal)
      values.set(result.values, offset)
    }
    return values
  }
  source(field: FieldRef, elementCount: number): MonitorSource {
    const csv = this
    const columns = this.byField.get(fieldKey(field))
    if (!columns) throw new Error('The field was not recorded.')
    return {
      elementCount,
      get frameCount() {
        return csv.info?.rows ?? 0
      },
      get timeRange() {
        return csv.info?.range ?? [0, 1]
      },
      valueRange: null,
      locate: (time, signal) => csv.locate(time, signal),
      async read(window: SourceWindow, signal?: AbortSignal) {
        const { frameOffset, frameCount, elementOffset, elementCount: count } = window
        if (
          ![frameOffset, frameCount, elementOffset, count].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          ) ||
          elementOffset + count > elementCount
        )
          throw new Error('Invalid sample window.')
        const time = new Float64Array(frameCount)
        const values = new Float64Array(frameCount * count)
        const columnsPerBlock = Math.max(1, Math.min(count, Math.floor(BLOCK_BYTES / 16)))
        for (let e = 0; e < count; e += columnsPerBlock) {
          const width = Math.min(columnsPerBlock, count - e)
          const framesPerBlock = Math.max(1, Math.floor(BLOCK_BYTES / (8 * (width + 1))))
          const requested = Array.from(
            { length: width },
            (_, i) => columns.get(elementOffset + e + i) ?? -1,
          )
          for (let f = 0; f < frameCount; f += framesPerBlock) {
            const size = Math.min(framesPerBlock, frameCount - f)
            const block = await csv.read(frameOffset + f, size, requested, signal)
            time.set(block.time, f)
            for (let row = 0; row < size; row++)
              values.set(
                block.values.subarray(row * width, (row + 1) * width),
                (f + row) * count + e,
              )
          }
        }
        return { time, values }
      },
    }
  }
  async dispose(): Promise<void> {
    this.connection.close()
    this.cache.clear()
    this.cacheBytes = 0
    await this.worker.terminate()
  }
}
