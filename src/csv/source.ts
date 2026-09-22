import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import {
  type ClassData,
  createEmitter,
  fieldKey,
  type FieldRef,
  type Results,
  type RunFrames,
  type Series,
} from '@latkit/model'
import { connect } from '@latkit/port'

import { sampleBudget } from '../budget.js'
import { SharedCache } from '../cache.js'
import { tableOpener } from '../table/session.js'
import type { CsvColumn } from './columns.js'
import { workerPort } from './port.js'
import { type CsvInfo, csvProtocol, type Samples } from './protocol.js'
export type { CsvInfo, Samples } from './protocol.js'
import { BLOCK_BYTES, sampleBytes } from './limits.js'
export { leasedSampleTiles, sampleTiles } from './tiles.js'
const CACHE_BYTES = 16 * 1024 * 1024

const sampleCache = new SharedCache<Samples>(
  CACHE_BYTES,
  (result) => result.time.byteLength + result.values.byteLength,
  256,
)

export class CsvSource implements Results {
  readonly id = randomUUID()
  private readonly worker: Worker
  private readonly tables
  private readonly connection
  private tableOpened = false
  private bindings: readonly CsvColumn[] = []
  private readonly fieldRefs = new Map<string, FieldRef>()
  private readonly byField = new Map<string, Map<number, number>>()
  private position?: { time: number; rows: number; frame: number }
  private readonly histories = new Map<string, { series: Series; publish(): void; clear(): void }>()
  info?: CsvInfo
  private disposal?: Promise<void>
  constructor(
    readonly path: string,
    workerPath = join(__dirname, 'csv/worker.cjs'),
  ) {
    this.worker = new Worker(workerPath, { workerData: { path } })
    this.connection = connect(workerPort(this.worker), csvProtocol)
    this.tables = tableOpener(workerPort(this.worker))
  }
  openTable(data: ClassData, fields: readonly FieldRef[], signal?: AbortSignal) {
    this.tableOpened = true
    return this.tables.open(
      data,
      fields.map((field) => {
        const columns = this.byField.get(fieldKey(field))
        if (!columns) throw new Error('The table field was not recorded.')
        return {
          id: '@signal:' + field.id,
          elements: Uint32Array.from(columns.keys()),
          columns: Uint32Array.from(columns.values()),
        }
      }),
      signal,
    )
  }
  get fields(): readonly FieldRef[] {
    return [...this.fieldRefs.values()]
  }
  get columns(): readonly CsvColumn[] {
    return this.bindings
  }
  set columns(columns: readonly CsvColumn[]) {
    if (this.histories.size || this.tableOpened)
      throw new Error('Recorded columns cannot change after a series or table is opened.')
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
    const info = (await this.connection.call({ type: 'scan', final }, { signal })) as CsvInfo
    signal?.throwIfAborted()
    this.info = info
    for (const history of this.histories.values()) history.publish()
    return info
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
    return (await this.samples(frame, 1, [], signal)).time[0]
  }
  private async samples(
    frameOffset: number,
    frameCount: number,
    columns: readonly number[],
    signal?: AbortSignal,
  ): Promise<Samples> {
    signal?.throwIfAborted()
    sampleBytes(frameCount, columns.length)
    const key = `${this.id}:${frameOffset}:${frameCount}:${columns.join(',')}`
    return sampleCache.get(
      key,
      async (abort) => {
        const release = await sampleBudget.acquire(
          sampleBytes(frameCount, columns.length) * 2,
          abort,
        )
        try {
          return (await this.connection.call(
            { type: 'read', frameOffset, frameCount, columns },
            { signal: abort },
          )) as Samples
        } finally {
          release()
        }
      },
      signal,
    )
  }
  async cellsAt(
    frame: number,
    fields: readonly FieldRef[],
    elements: readonly number[],
    signal?: AbortSignal,
  ): Promise<Float64Array> {
    signal?.throwIfAborted()
    sampleBytes(1, fields.length * elements.length)
    const values = new Float64Array(fields.length * elements.length).fill(NaN)
    if (frame < 0) return values
    const maps = fields.map((field) => this.byField.get(fieldKey(field)))
    const chunk = Math.max(1, Math.floor(BLOCK_BYTES / 8) - 1)
    for (let offset = 0; offset < values.length; offset += chunk) {
      const count = Math.min(chunk, values.length - offset)
      const columns = Array.from({ length: count }, (_, i) => {
        const at = offset + i
        return maps[at % fields.length]?.get(elements[Math.floor(at / fields.length)]) ?? -1
      })
      const result = await this.samples(frame, 1, columns, signal)
      values.set(result.values, offset)
    }
    return values
  }
  /** Recorded signals in their stable column order. */
  signals(classId: string): readonly FieldRef[] {
    return this.fields.filter((field) => field.classId === classId)
  }
  async series(classId: string, signal?: AbortSignal): Promise<Series> {
    signal?.throwIfAborted()
    const existing = this.histories.get(classId)
    if (existing) return existing.series
    const fields = this.signals(classId)
    if (!fields.length) throw new Error('The class was not recorded.')
    const maps = fields.map((field) => this.byField.get(fieldKey(field))!)
    const elements = Uint32Array.from(
      [...new Set(maps.flatMap((map) => [...map.keys()]))].sort((a, b) => a - b),
    )
    const csv = this
    const events = createEmitter<{ append: undefined }>()
    let state = this.seriesState()
    const series: Series = {
      elementCount: elements.length,
      signalCount: fields.length,
      elements,
      get state() {
        return state
      },
      on: (event, listener) => events.on(event, listener),
      locate: async (range, frameCount, abort) =>
        (await csv.connection.call(
          { type: 'bounds', range, frameCount },
          { signal: abort },
        )) as readonly [number, number],
      async read(signalIndex, window, abort) {
        const { frameOffset, frameCount, elementOffset, elementCount } = window
        if (
          ![signalIndex, frameOffset, frameCount, elementOffset, elementCount].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          ) ||
          signalIndex >= maps.length ||
          elementOffset + elementCount > elements.length ||
          frameOffset + frameCount > state.frameCount
        )
          throw new RangeError('Invalid sample window.')
        abort?.throwIfAborted()
        sampleBytes(frameCount, elementCount)
        const columns = Array.from(
          elements.subarray(elementOffset, elementOffset + elementCount),
          (element) => maps[signalIndex].get(element) ?? -1,
        )
        if (frameCount * (elementCount + 1) * 8 <= BLOCK_BYTES)
          return {
            ...(await csv.samples(frameOffset, frameCount, columns, abort)),
            stride: elementCount,
          }
        const time = new Float64Array(frameCount)
        const values = new Float64Array(frameCount * elementCount)
        const width = Math.max(1, Math.min(elementCount, Math.floor(BLOCK_BYTES / 16)))
        for (let e = 0; e < Math.max(1, elementCount); e += width) {
          const selected = columns.slice(e, e + width)
          const frames = Math.max(1, Math.floor(BLOCK_BYTES / (8 * (selected.length + 1))))
          for (let f = 0; f < frameCount; f += frames) {
            const count = Math.min(frames, frameCount - f)
            const block = await csv.samples(frameOffset + f, count, selected, abort)
            time.set(block.time, f)
            for (let row = 0; row < count; row++)
              values.set(
                block.values.subarray(row * selected.length, (row + 1) * selected.length),
                (f + row) * elementCount + e,
              )
          }
        }
        return { time, values, stride: elementCount }
      },
    }
    this.histories.set(classId, {
      series,
      publish: () => {
        const next = csv.seriesState()
        if (next.frameCount <= state.frameCount) return
        state = next
        events.emit('append', undefined)
      },
      clear: () => events.clear(),
    })
    return series
  }
  private seriesState(): Series['state'] {
    return Object.freeze({
      frameCount: this.info?.rows ?? 0,
      timeRange: this.info?.range ? ([...this.info.range] as const) : null,
      ranges: null,
    })
  }
  async *read(
    classId: string,
    signals: readonly number[] | null,
    signal?: AbortSignal,
  ): AsyncIterable<RunFrames> {
    const series = await this.series(classId, signal)
    const picked = signals ?? Array.from({ length: series.signalCount }, (_, i) => i)
    if (picked.some((s) => !Number.isSafeInteger(s) || s < 0 || s >= series.signalCount))
      throw new RangeError('Signal out of range.')
    const { elementCount, elements } = series
    const head = series.state.frameCount
    sampleBytes(1, elementCount * picked.length)
    const frames = Math.max(1, Math.floor(BLOCK_BYTES / (8 * (elementCount * picked.length + 1))))
    for (let f = 0; f < head; f += frames) {
      const count = Math.min(frames, head - f)
      let time: Float64Array | undefined
      const values = new Float64Array(count * elementCount * picked.length)
      for (let s = 0; s < picked.length; s++) {
        const block = await series.read(
          picked[s],
          { frameOffset: f, frameCount: count, elementOffset: 0, elementCount },
          signal,
        )
        time = block.time
        for (let row = 0; row < count; row++)
          values.set(
            block.values.subarray(row * block.stride, row * block.stride + elementCount),
            (row * picked.length + s) * elementCount,
          )
      }
      time ??= (await this.samples(f, count, [], signal)).time
      yield {
        resultId: this.id,
        classId,
        elementCount,
        elements,
        signalCount: picked.length,
        time,
        values,
      }
    }
  }
  dispose(): Promise<void> {
    return (this.disposal ??= this.close())
  }
  private async close(): Promise<void> {
    for (const history of this.histories.values()) history.clear()
    this.histories.clear()
    this.tables.close()
    this.connection.close()
    sampleCache.deleteWhere((key) => key.startsWith(this.id + ':'))
    await this.worker.terminate()
  }
}
